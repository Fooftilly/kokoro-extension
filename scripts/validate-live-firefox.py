"""Real ONNX phoneme synthesis inside an unsigned temporary Firefox MV3 extension.

Runs only from the opt-in live acceptance workflow. No model weights are committed.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.request

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait


def pinned_manifest():
    # Load the SAME source-of-truth JS catalog as the packaged extension.
    with tempfile.TemporaryDirectory() as d:
        esm = Path(d) / "model-catalog.mjs"
        esm.write_text(Path("model-catalog.js").read_text(encoding="utf-8"), encoding="utf-8")
        code = f"import {{ manifestForVariant }} from {json.dumps(esm.as_uri())}; console.log(JSON.stringify(manifestForVariant('onnx','q8')))"
        result = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            check=True, capture_output=True, text=True,
        )
        return json.loads(result.stdout)


def verified_assets(manifest, directory):
    files = {}
    for asset in manifest["assets"]:
        name = asset["path"]
        digest_bytes = __import__("base64").b64decode(asset["integrity"][7:])
        digest = digest_bytes.hex()
        filename = directory / digest
        with urllib.request.urlopen(asset["url"], timeout=90) as source, open(filename, "wb") as target:
            hasher = hashlib.sha256()
            size = 0
            while block := source.read(1024 * 1024):
                target.write(block)
                hasher.update(block)
                size += len(block)
        if size != asset["bytes"] or hasher.digest() != digest_bytes:
            raise ValueError("Unverified model data " + name)
        files[digest] = filename
        print("Verified official model data", name, size, flush=True)
    return files


def main():
    if os.environ.get("KOKORO_LIVE_DOWNLOAD") != "1":
        raise RuntimeError("Explicit model download opt-in is required")
    output = Path("dist/runtime-acceptance/firefox.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"status": "started", "browser": "Firefox MV3"}
    driver = None
    server = None
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-") as tmp:
        root = Path(tmp)
        try:
            manifest = pinned_manifest()
            files = verified_assets(manifest, root)
            token = secrets.token_hex(32)
            state = {"origin": None}
            class Server(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    from urllib.parse import parse_qs, urlsplit
                    parts = urlsplit(self.path)
                    origin = self.headers.get("Origin")
                    if (parse_qs(parts.query).get("token") != [token] or
                        (origin and origin != state["origin"]) or
                        state["origin"] is None or
                        self.client_address[0] != "127.0.0.1"):
                        self.send_error(403)
                        return
                    file = files.get(parts.path.removeprefix("/"))
                    if not file:
                        self.send_error(404)
                        return
                    self.send_response(200)
                    self.send_header("Access-Control-Allow-Origin", state["origin"])
                    self.send_header("Vary", "Origin")
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(file.stat().st_size))
                    self.end_headers()
                    with file.open("rb") as stream:
                        while block := stream.read(1024 * 1024):
                            self.wfile.write(block)
                def log_message(self, *args):
                    return
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            options = Options()
            options.binary_location = os.environ["FIREFOX_BINARY"]
            options.add_argument("-headless")
            options.set_preference("xpinstall.signatures.required", False)
            options.set_preference("extensions.experiments.enabled", True)
            driver = webdriver.Firefox(options=options)
            driver.set_script_timeout(250)
            addon_path = Path("dist/package/kokoro-extension-firefox-1.4.0.zip").resolve()
            addon_id = driver.install_addon(str(addon_path), temporary=True)
            driver.set_context("chrome")
            pref = driver.execute_script(
                "return Services.prefs.getStringPref('extensions.webextensions.uuids', '{}');"
            )
            driver.set_context("content")
            id_map = json.loads(pref)
            uuid = id_map.get(addon_id)
            if not uuid:
                raise RuntimeError(f"Firefox did not expose a temporary extension origin for {addon_id}; keys={list(id_map)}")
            state["origin"] = "moz-extension://" + uuid
            driver.get(state["origin"] + "/benchmark.html")
            WebDriverWait(driver, 20).until(
                lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            preflight = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                window.KokoroBenchmark.inspectCapabilities().then(done, e=>done({error:String(e)}));
            """)
            if not preflight.get("wasmCompilation"):
                raise RuntimeError("Firefox MV3 extension-page WASM compilation unavailable: " + str(preflight))

            # Use only pinned bytes verified on the runner, and copy to the
            # extension's cache. The loopback server never receives TTS text.
            driver.execute_async_script("""
                const [manifest,port,token,done]=arguments;
                (async()=>{
                    const {ModelDataStore}=await import('./model-data-store.js');
                    const store=new ModelDataStore({origin:browser.runtime.getURL('/'),
                        cacheStorage:caches,fetchImpl:fetch,
                        responseClass:Response,streamClass:TransformStream});
                    const cache=await caches.open('kokoro-model-data-v1');
                    for(const asset of manifest.assets){
                        const raw=Uint8Array.from(atob(asset.integrity.slice(7)),c=>c.charCodeAt(0));
                        const hex=Array.from(raw).map(b=>b.toString(16).padStart(2,'0')).join('');
                        const response=await fetch('http://127.0.0.1:'+port+'/'+hex+'?token='+token);
                        if(!response.ok)throw Error('Browser model handoff HTTP '+response.status);
                        await cache.put(store.key(manifest,asset),new Response(response.body,{headers:{
                            'x-kokoro-integrity':asset.integrity,
                            'x-kokoro-bytes':String(asset.bytes)}}));
                    }
                    if(!(await store.status(manifest)).ready)throw Error('Browser cache not ready');
                    done({success:true});
                })().catch(e=>done({success:false,error:String(e)}));
            """, manifest, server.server_port, token)
            metrics = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                (async()=>{
                    let engine;
                    try{
                        const {OnnxKokoroProvider}=await import('./onnx-provider.js');
                        engine=new OnnxKokoroProvider({variant:'q8'});
                        const start=performance.now();
                        await engine.initialize();
                        const initMs=performance.now()-start;
                        const samples=[];
                        let audio;
                        for(let i=0;i<3;i++){
                            const t=performance.now();
                            audio=await engine.synthesizePhonemes('hɛˈloʊ.');
                            samples.push(performance.now()-t);
                        }
                        const rms=Math.sqrt(audio.samples.reduce((s,v)=>s+v*v,0)/audio.samples.length);
                        if(!(rms>0.0001)||audio.sampleRateHz!==24000||
                            !audio.samples.every(Number.isFinite))throw Error('Invalid or silent PCM');
                        done({success:true,initMs,warmSynthesisMs:samples,
                            durationSec:audio.samples.length/audio.sampleRateHz,
                            sampleRateHz:audio.sampleRateHz,rms});
                    }catch(e){done({success:false,error:String(e),stack:String(e.stack||'')});}
                    finally{try{await engine?.close()}catch{}}
                })().catch(e=>done({success:false,error:String(e)}));
            """)
            result = {"status": "passed" if metrics.get("success") else "failed",
                "browser": driver.capabilities.get("browserVersion"), "extensionId": addon_id,
                "preflight": preflight, "onnx": metrics,
                "scope": "Firefox/Linux MV3 real ONNX q8 IPA inference; no G2P or MediaPipe"}
            print("FIREFOX REAL INFERENCE", json.dumps(result), flush=True)
            if not metrics.get("success"):
                raise RuntimeError("Firefox model-backed ONNX inference failed")
        except Exception as exc:
            result["status"] = "failed"
            result["error"] = str(exc)
            raise
        finally:
            output.write_text(json.dumps(result, indent=2), encoding="utf-8")
            if driver:
                driver.quit()
            if server:
                server.shutdown()


if __name__ == "__main__":
    main()
