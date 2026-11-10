"""Real, opt-in Kokoro model inference inside a temporary Firefox MV3 extension.

Default: ONNX q8 + dictionary. KOKORO_FIREFOX_PROVIDER=mediapipe tests official
MediaPipe CPU separately, so large runtimes never share one Firefox renderer.
No model weights are committed; locally pinned models are rehashed before reuse.
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
from urllib.parse import urlsplit

import urllib3
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def pinned_manifest(provider):
    # Read the fixed in-repository catalog as ESM without trusting external
    # paths. Keep the default ONNX+dictionary acceptance unchanged.
    code = (
        "import {readFile} from 'node:fs/promises'; "
        "const catalog = await readFile('model-catalog.js'); "
        "const source = 'data:text/javascript;base64,' + catalog.toString('base64'); "
        "const {manifestForVariant,dictionaryManifest} = await import(source); "
        "const provider = process.argv[1]; "
        "console.log(JSON.stringify(provider === 'mediapipe' "
        " ? [manifestForVariant('mediapipe', 'cpu')] "
        " : [manifestForVariant('onnx', 'q8'), dictionaryManifest()]));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code, provider],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout)

def verified_assets(manifest, directory):
    files = {}
    http = urllib3.PoolManager()
    for asset in manifest["assets"]:
        name = asset["path"]
        # The model comes from official Hugging Face; CMUdict is pinned to its
        # original upstream GitHub commit. Neither URL is user-controlled.
        url = urlsplit(asset["url"])
        if manifest["provider"] == "dictionary":
            host = "raw.githubusercontent.com"
            expected = f"/cmusphinx/cmudict/{manifest['revision']}/cmudict.dict"
        elif manifest["provider"] == "mediapipe":
            host = "huggingface.co"
            expected = (f"/litert-community/Kokoro-82M/"
                        f"resolve/{manifest['revision']}/{name}")
        elif manifest["provider"] == "onnx":
            host = "huggingface.co"
            expected = (f"/onnx-community/Kokoro-82M-v1.0-ONNX/"
                        f"resolve/{manifest['revision']}/{name}")
        else:
            raise ValueError("Unsupported model provider")
        if (url.scheme != "https" or url.netloc != host or
                url.path != expected or url.query or url.fragment):
            raise ValueError("Untrusted or unpinned model/dictionary asset URL")
        digest_bytes = __import__("base64").b64decode(asset["integrity"][7:])
        digest = digest_bytes.hex()
        filename = directory / digest
        reused = Path(tempfile.gettempdir()) / "kokoro-live-models" / digest

        def matches_pinned_file(candidate):
            if not candidate.is_file() or candidate.stat().st_size != asset["bytes"]:
                return False
            hasher = hashlib.sha256()
            with candidate.open("rb") as source:
                while block := source.read(1024 * 1024):
                    hasher.update(block)
            return hasher.digest() == digest_bytes

        if matches_pinned_file(reused):
            files[digest] = reused
            print("Reused checksum-verified local model data", name, asset["bytes"], flush=True)
            continue

        with http.request("GET", asset["url"], preload_content=False,
                          timeout=urllib3.Timeout(connect=15, read=90)) as source, \
                open(filename, "wb") as target:
            if source.status != 200:
                raise RuntimeError(f"Official model download returned HTTP {source.status}")
            hasher = hashlib.sha256()
            size = 0
            while block := source.read(1024 * 1024):
                size += len(block)
                if size > asset["bytes"]:
                    raise ValueError("Official model asset exceeds the pinned size")
                target.write(block)
                hasher.update(block)
        if size != asset["bytes"] or hasher.digest() != digest_bytes:
            raise ValueError("Unverified model data " + name)
        files[digest] = filename
        print("Downloaded and verified official model data", name, size, flush=True)
    return files


def main():
    if os.environ.get("KOKORO_LIVE_DOWNLOAD") != "1":
        raise RuntimeError("Explicit model download opt-in is required")
    provider = os.environ.get("KOKORO_FIREFOX_PROVIDER", "onnx")
    if provider not in ("onnx", "mediapipe"):
        raise ValueError("KOKORO_FIREFOX_PROVIDER must be onnx or mediapipe")
    output = Path("dist/runtime-acceptance/firefox.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"status": "started", "browser": "Firefox MV3"}
    driver = None
    server = None
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-") as tmp:
        root = Path(tmp)
        try:
            manifests = pinned_manifest(provider)
            files = {}
            for manifest in manifests:
                files.update(verified_assets(manifest, root))
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
            package_version = json.loads(Path("package.json").read_text(encoding="utf-8"))["version"]
            addon_path = (Path("dist/package") /
                          f"kokoro-extension-firefox-{package_version}.zip").resolve()
            if not addon_path.is_file():
                raise FileNotFoundError(f"Packaged Firefox extension not found: {addon_path}")
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
            dictionary_cache_acceptance = None
            dictionary_reload_acceptance = None
            preflight = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                window.KokoroBenchmark.inspectCapabilities().then(done, e=>done({error:String(e)}));
            """)
            if not preflight.get("wasmCompilation"):
                raise RuntimeError("Firefox MV3 extension-page WASM compilation unavailable: " + str(preflight))

            # Check real pinned dictionary CORS/SRI download in the packaged
            # extension itself. Model-weight preload below remains loopback.
            dictionary_cache_acceptance = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                (async()=>{
                    const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                        import('./model-data-store.js'),import('./model-catalog.js')]);
                    const manifest=dictionaryManifest();
                    let networkFetches=0,reportedBytes=0;
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:(...args)=>{networkFetches++;return fetch(...args)},
                        responseClass:Response,streamClass:TransformStream});
                    await store.remove(manifest);
                    if((await store.status(manifest)).ready)
                        throw Error('Dictionary persisted after explicit removal');
                    await store.install(manifest,{onProgress:({completedBytes})=>{
                        reportedBytes=completedBytes;
                    }});
                    const verified=await store.verifyAndPruneCorrupt(manifest);
                    if(!verified.ready||verified.removedAssets!==0||
                        reportedBytes!==manifest.assets[0].bytes||networkFetches!==1)
                        throw Error('Pinned dictionary CORS/SRI download or SHA-256 failed');
                    await store.install(manifest);
                    if(networkFetches!==1)
                        throw Error('Checksum-matching retry fetched again');
                    // Keep this entry for the extension-page reload probe.
                    return {success:true,provider:'dictionary',byteCount:reportedBytes,
                        directOfficialHttpsFetches:networkFetches,verifiedSha256:true,
                        cachedRetryWithoutFetch:true,retainedForPageReload:true};
                })().then(done,e=>done({success:false,error:String(e)}));
            """)
            if not dictionary_cache_acceptance.get("success"):
                raise RuntimeError("Firefox direct dictionary cache acceptance failed: " +
                                   str(dictionary_cache_acceptance))
            # Temporary Firefox add-ons are not retained across browser
            # restarts. Exercise a fresh extension document instead; never
            # mislabel this as browser-process persistence acceptance.
            driver.refresh()
            WebDriverWait(driver, 20).until(
                lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            # First require the fresh UI to observe the retained dictionary.
            WebDriverWait(driver, 30).until(
                lambda d: "Installed" in d.find_element(
                    By.CSS_SELECTOR,
                    '[data-variant="dictionary-english"] .model-status'
                ).text and d.find_element(
                    By.CSS_SELECTOR,
                    '[data-variant="dictionary-english"] .model-remove'
                ).is_enabled()
            )
            dictionary_reload_acceptance = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                (async()=>{
                    const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                        import('./model-data-store.js'),import('./model-catalog.js')]);
                    const manifest=dictionaryManifest();
                    let fetches=0;
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:(...args)=>{fetches++;return fetch(...args)},
                        responseClass:Response,streamClass:TransformStream});
                    if(!(await store.status(manifest)).ready)
                        throw Error('Dictionary missing after extension page reload');
                    const verified=await store.verifyAndPruneCorrupt(manifest);
                    if(!verified.ready||verified.removedAssets||fetches)
                        throw Error('Dictionary integrity lost on page reload');
                    const cache=await caches.open('kokoro-model-data-v1');
                    if(!await cache.delete(store.key(manifest,manifest.assets[0])))
                        throw Error('Unable to simulate dictionary eviction');
                    if((await store.status(manifest)).ready||fetches)
                        throw Error('Evicted dictionary not detected or fetched implicitly');
                    // Leave dictionary evicted until the real manager Recheck
                    // button has observed its missing state.
                    return {success:true,extensionPageReloaded:true,
                        browserProcessRestarted:false,
                        dictionarySha256Retained:true,simulatedEvictionDetected:true};
                })().then(done,e=>done({success:false,error:String(e)}));
            """)
            if not dictionary_reload_acceptance.get("success"):
                raise RuntimeError("Firefox dictionary reload/eviction acceptance failed: " +
                                   str(dictionary_reload_acceptance))
            # The packaged extension UI must first observe the missing
            # dictionary. Explicit repair happens only after this transition.
            WebDriverWait(driver, 20).until(
                lambda d: d.find_element(By.ID, "refreshModelCache").is_enabled()
            )
            row = '[data-variant="dictionary-english"]'
            driver.find_element(By.ID, "refreshModelCache").click()
            WebDriverWait(driver, 30).until(
                lambda d: "Cached model data is missing" in
                d.find_element(By.CSS_SELECTOR, row + " .model-status").text
                and not d.find_element(By.CSS_SELECTOR, row + " .model-remove").is_enabled()
                and d.find_element(By.CSS_SELECTOR, row + " .model-download").is_enabled()
            )
            repair = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                (async()=>{
                    const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                        import('./model-data-store.js'),import('./model-catalog.js')]);
                    const manifest=dictionaryManifest();
                    let fetches=0;
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:(...args)=>{fetches++;return fetch(...args)},
                        responseClass:Response,streamClass:TransformStream});
                    if((await store.status(manifest)).ready)
                        throw Error('Dictionary unexpectedly restored before opt-in');
                    await store.install(manifest);
                    if(fetches!==1||(await store.verifyAndPruneCorrupt(manifest)).ready!==true)
                        throw Error('Explicit dictionary repair failed');
                    return {success:true,explicitRepairFetches:fetches};
                })().then(done,e=>done({success:false,error:String(e)}));
            """)
            if not repair.get("success"):
                raise RuntimeError("Firefox explicit dictionary repair failed: " + str(repair))
            dictionary_reload_acceptance.update(repair)
            # The manager binds window.fetch when its handlers construct
            # ModelDataStore. Block/record unexpected model URL requests.
            driver.execute_script("""
                const original=globalThis.fetch.bind(globalThis);
                globalThis.__modelManagerAssetFetches=0;
                globalThis.fetch=(...args)=>{
                    const url=String(args[0]?.url||args[0]);
                    if(url.startsWith('https://huggingface.co/')||
                        url.startsWith('https://raw.githubusercontent.com/')){
                        globalThis.__modelManagerAssetFetches++;
                        throw Error('Unexpected model fetch by manager UI');
                    }
                    return original(...args);
                };
            """)
            driver.find_element(By.ID, "refreshModelCache").click()
            WebDriverWait(driver, 30).until(
                lambda d: d.find_element(By.CSS_SELECTOR, row + " .model-remove").is_enabled()
                and "Installed" in d.find_element(By.CSS_SELECTOR, row + " .model-status").text
            )
            driver.find_element(By.CSS_SELECTOR, row + " .model-remove").click()
            WebDriverWait(driver, 30).until(
                lambda d: "Not installed" in
                d.find_element(By.CSS_SELECTOR, row + " .model-status").text
                and not d.find_element(By.CSS_SELECTOR, row + " .model-remove").is_enabled()
                and d.find_element(By.CSS_SELECTOR, row + " .model-download").is_enabled()
            )
            after_ui_removal = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                (async()=>{
                    const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                        import('./model-data-store.js'),import('./model-catalog.js')]);
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:()=>{throw Error('Unexpected removal fetch')},
                        responseClass:Response,streamClass:TransformStream});
                    return {...(await store.status(dictionaryManifest())),
                        pageModelFetches:globalThis.__modelManagerAssetFetches};
                })().then(done,e=>done({error:String(e)}));
            """)
            if (after_ui_removal.get("ready") or after_ui_removal.get("storedBytes") != 0
                    or after_ui_removal.get("pageModelFetches") != 0):
                raise RuntimeError("Firefox manager cache or fetch check failed: " +
                                   str(after_ui_removal))
            dictionary_reload_acceptance.update({
                "modelManagerRecheckClicked": True,
                "modelManagerRemoveClicked": True,
                "uiEvictionObservedBeforeRepair": True,
                "noUiModelFetches": True,
                "uiRemovalVerifiedInCache": True,
            })
            # Use only pinned bytes verified on the runner, and copy to the
            # extension's cache. The loopback server never receives TTS text.
            cache_result = driver.execute_async_script("""
                const [manifests,port,token,done]=arguments;
                (async()=>{
                    const {ModelDataStore}=await import('./model-data-store.js');
                    const store=new ModelDataStore({origin:browser.runtime.getURL('/'),
                        cacheStorage:caches,fetchImpl:fetch,
                        responseClass:Response,streamClass:TransformStream});
                    const cache=await caches.open('kokoro-model-data-v1');
                    for(const manifest of manifests)for(const asset of manifest.assets){
                        const raw=Uint8Array.from(atob(asset.integrity.slice(7)),c=>c.charCodeAt(0));
                        const hex=Array.from(raw).map(b=>b.toString(16).padStart(2,'0')).join('');
                        const response=await fetch('http://127.0.0.1:'+port+'/'+hex+'?token='+token);
                        if(!response.ok)throw Error('Browser model handoff HTTP '+response.status);
                        await cache.put(store.key(manifest,asset),new Response(response.body,{headers:{
                            'x-kokoro-integrity':asset.integrity,
                            'x-kokoro-bytes':String(asset.bytes)}}));
                    }
                    for(const manifest of manifests){
                        if(!(await store.status(manifest)).ready)throw Error('Browser cache not ready: '+manifest.provider);
                    }
                    done({success:true});
                })().catch(e=>done({success:false,error:String(e)}));
            """, manifests, server.server_port, token)
            if not cache_result.get("success"):
                raise RuntimeError("Firefox extension cache preload failed: " + str(cache_result))
            # Require the actual packaged Firefox extension to load cached
            # executable assets, weights, and dictionary while Firefox is
            # offline. Geckodriver commands remain local browser automation.
            driver.set_context("chrome")
            try:
                browser_offline = driver.execute_script("""
                    Services.io.manageOfflineStatus = false;
                    Services.io.offline = true;
                    return Services.io.offline;
                """)
            finally:
                driver.set_context("content")
            if not browser_offline or not driver.execute_script("return navigator.onLine === false;"):
                raise RuntimeError("Firefox did not enter offline mode before inference")
            metrics = driver.execute_async_script("""
                const provider=arguments[0];
                const done=arguments[arguments.length-1];
                (async()=>{
                    let engine;
                    try{
                        const sdk=provider==='mediapipe'
                            ? await import('./mediapipe-provider.js')
                            : await import('./onnx-provider.js');
                        engine=provider==='mediapipe'
                            ? new sdk.MediaPipeKokoroProvider({variant:'cpu'})
                            : new sdk.OnnxKokoroProvider({variant:'q8'});
                        const start=performance.now();
                        await engine.initialize();
                        const initMs=performance.now()-start;
                        const samples=[];
                        let audio;
                        for(let i=0;i<3;i++){
                            const t=performance.now();
                            audio=provider==='mediapipe'
                                ? await engine.synthesize('Hello from Kokoro running on this device.')
                                : await engine.synthesizePhonemes('hɛˈloʊ.');
                            samples.push(performance.now()-t);
                        }
                        let englishText=null;
                        if(provider==='onnx'){
                            // Keep the dictionary-text check separate from IPA timings.
                            const words=await engine.synthesize('Hello world.');
                            const englishRms=Math.sqrt(words.samples.reduce(
                                (s,v)=>s+v*v,0)/words.samples.length);
                            if(!(englishRms>0.0001)||words.sampleRateHz!==24000||
                                !words.samples.every(Number.isFinite))
                                throw Error('Invalid ONNX English dictionary PCM');
                            englishText={input:'Hello world.',rms:englishRms,
                                durationSec:words.samples.length/words.sampleRateHz};
                        }
                        const rms=Math.sqrt(audio.samples.reduce((s,v)=>s+v*v,0)/audio.samples.length);
                        const durationSec=audio.samples.length/audio.sampleRateHz;
                        if(!(rms>0.0001)||audio.sampleRateHz!==24000||
                            !audio.samples.every(Number.isFinite)||
                            !(durationSec>=0.2 && durationSec<=30))
                            throw Error('Invalid or silent PCM');
                        done({success:true,provider,initMs,warmSynthesisMs:samples,
                            durationSec,sampleRateHz:audio.sampleRateHz,rms,englishText});
                    }catch(e){done({success:false,provider,error:String(e),stack:String(e.stack||'')});}
                    finally{try{await engine?.close()}catch{}}
                })().catch(e=>done({success:false,provider,error:String(e)}));
            """, provider)
            result = {"status": "passed" if metrics.get("success") else "failed",
                "browser": driver.capabilities.get("browserVersion"), "extensionId": addon_id,
                "preflight": preflight, "provider": provider, provider: metrics,
                "dictionaryCacheAcceptance": dictionary_cache_acceptance,
                "dictionaryReloadAcceptance": dictionary_reload_acceptance,
                "offlineAttempted": True,
                "offlineInference": metrics.get("success") is True,
                "cachePopulation": "model weights preloaded over loopback; dictionary tested with real pinned HTTPS CORS/SRI; Download UI not exercised",
                "scope": "Firefox/Linux MV3 offline " + provider +
                         " CPU synthesis; no subjective audio-quality or long-form acceptance"}
            print("FIREFOX REAL INFERENCE", json.dumps(result), flush=True)
            if not metrics.get("success"):
                raise RuntimeError("Firefox model-backed " + provider + " inference failed")
        except Exception as exc:
            result["status"] = "failed"
            result["error"] = str(exc)
            if "dictionary_cache_acceptance" in locals():
                result["dictionaryCacheAcceptance"] = dictionary_cache_acceptance
            if "dictionary_reload_acceptance" in locals():
                result["dictionaryReloadAcceptance"] = dictionary_reload_acceptance
            raise
        finally:
            output.write_text(json.dumps(result, indent=2), encoding="utf-8")
            if driver:
                # The isolated temporary browser is discarded; no need to
                # restore network state or mask an underlying test failure.
                driver.quit()
            if server:
                server.shutdown()


if __name__ == "__main__":
    main()
