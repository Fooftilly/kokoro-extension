"""Real, opt-in Kokoro model inference inside a temporary Firefox MV3 extension.

Default: ONNX q8 + dictionary. KOKORO_FIREFOX_PROVIDER=mediapipe tests official
MediaPipe CPU separately, so large runtimes never share one Firefox renderer.
No model weights are committed; locally pinned models are rehashed before reuse.
"""
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

import urllib3
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service as FirefoxService
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

from firefox_article_selection_acceptance import (
    assert_distinct_article_selection_audio_hashes,
    article_selection_storage_config,
    load_article_selection_fixture,
    origin_article_selection_stage_enabled,
    require_article_selection_backend,
)
from firefox_epub_acceptance import (
    assert_distinct_chapter_audio_hashes,
    epub_backend_variant,
    origin_epub_stage_enabled,
    reader_storage_config,
    require_epub_backend,
)
from firefox_long_form_memory_acceptance import (
    LONG_FORM_SENTENCE_COUNT,
    assert_bounded_audio_manager_stats,
    assert_long_form_cache_window_near,
    assert_long_form_heap_delta,
    load_long_form_fixture,
    origin_long_form_memory_stage_enabled,
    require_long_form_backend,
)
from reader_acceptance_epub import (
    READER_ACCEPTANCE_SPEECH,
    build_reader_acceptance_epub,
)


def pinned_manifest(provider):
    # Read the fixed in-repository catalog as ESM without trusting external
    # paths. Keep the default ONNX+dictionary acceptance unchanged.
    code = (
        "import {readFile} from 'node:fs/promises'; "
        "const catalog = await readFile('model-catalog.js'); "
        "const source = 'data:text/javascript;base64,' + catalog.toString('base64'); "
        "const {manifestForVariant,dictionaryManifest} = await import(source); "
        "const provider = process.argv[1]; "
        "console.log(JSON.stringify(provider === 'both' "
        " ? [manifestForVariant('onnx', 'q8'), "
        "manifestForVariant('mediapipe', 'cpu'), dictionaryManifest()] "
        " : provider === 'dictionary' ? [dictionaryManifest()] : provider === 'mediapipe' "
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



def run_dictionary_ui_acceptance(driver):
    """Exercise genuine Firefox extension Download/Cancel/Retry/Remove UI."""
    row = '[data-variant="dictionary-english"]'
    driver.refresh()  # Remove the earlier page-window no-fetch assertion guard.
    WebDriverWait(driver, 30).until(
        lambda d: "Not installed" in
        d.find_element(By.CSS_SELECTOR, row + " .model-status").text
        and d.find_element(By.CSS_SELECTOR, row + " .model-download").is_enabled()
    )
    button = row + " .model-download"
    # Each Marionette script has its own sandbox: install the fetch hook on the
    # actual extension page and export the callback into that window.
    driver.execute_script("""
        const page=window.wrappedJSObject||window;
        const original=page.fetch;
        if(typeof original!=='function')throw Error('Missing page fetch');
        page.__dictionaryUiOriginalFetch=original;
        page.__dictionaryUiStalledFetches=0;
        const stall=(input,options)=>{
            const url=String(input?.url||input);
            if(!url.includes('/cmudict.dict'))return original.apply(page,[input,options]);
            page.__dictionaryUiStalledFetches++;
            return new Promise((resolve,reject)=>{
                const cancel=()=>reject(new DOMException('Download aborted','AbortError'));
                if(options?.signal?.aborted)cancel();
                else options?.signal?.addEventListener('abort',cancel,{once:true});
            });
        };
        if(typeof exportFunction==='function')
            exportFunction(stall,page,{defineAs:'fetch'});
        else page.fetch=stall;
    """)
    driver.find_element(By.CSS_SELECTOR, button).click()
    try:
        WebDriverWait(driver, 45).until(
            lambda d: d.find_element(By.CSS_SELECTOR, button).text == "Cancel download"
            and d.find_element(By.CSS_SELECTOR, button).is_enabled()
            and d.execute_script(
                "return (window.wrappedJSObject||window).__dictionaryUiStalledFetches===1"
            )
        )
    except Exception as exc:
        status = driver.find_element(By.CSS_SELECTOR, row + " .model-status").text
        raise RuntimeError("Firefox UI did not start the abortable pinned fetch; "
                           "check headless optional host permission prompt: " + status) from exc
    driver.find_element(By.CSS_SELECTOR, button).click()
    WebDriverWait(driver, 30).until(
        lambda d: "Download cancelled" in
        d.find_element(By.CSS_SELECTOR, row + " .model-status").text
        and d.find_element(By.CSS_SELECTOR, button).is_enabled()
        and d.find_element(By.CSS_SELECTOR, button).text.startswith("Download")
        and d.find_element(By.CSS_SELECTOR, row + " .model-download-progress")
        .get_attribute("hidden") is not None
    )
    cancelled = driver.execute_async_script("""
        const done=arguments[arguments.length-1];
        (async()=>{
            const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Cancelled download unexpectedly fetched')},
                responseClass:Response,streamClass:TransformStream});
            return {...(await store.status(dictionaryManifest())),
                stalledFetches:(window.wrappedJSObject||window).__dictionaryUiStalledFetches};
        })().then(done,e=>done({error:String(e)}));
    """)
    if (cancelled.get("ready") or cancelled.get("storedBytes") != 0 or
            cancelled.get("stalledFetches") != 1):
        raise RuntimeError("Firefox Cancel left cached bytes or skipped real fetch: " +
                           str(cancelled))
    # Only the explicit second click is permitted to fetch the actual HTTPS
    # dictionary; preserve its count on the real page across Marionette calls.
    driver.execute_script("""
        const page=window.wrappedJSObject||window;
        const original=page.__dictionaryUiOriginalFetch;
        if(typeof original!=='function')throw Error('Missing native fetch');
        page.__dictionaryUiRealFetches=0;
        const tracked=(input,options)=>{
            const url=String(input?.url||input);
            if(url.includes('/cmudict.dict'))page.__dictionaryUiRealFetches++;
            return original.apply(page,[input,options]);
        };
        if(typeof exportFunction==='function')
            exportFunction(tracked,page,{defineAs:'fetch'});
        else page.fetch=tracked;
    """)
    driver.find_element(By.CSS_SELECTOR, button).click()
    WebDriverWait(driver, 120).until(
        lambda d: "Installed" in
        d.find_element(By.CSS_SELECTOR, row + " .model-status").text
        and d.find_element(By.CSS_SELECTOR, row + " .model-remove").is_enabled()
        and d.find_element(By.CSS_SELECTOR, row + " .model-download-progress")
        .get_attribute("value") == "100"
    )
    installed = driver.execute_async_script("""
        const done=arguments[arguments.length-1];
        (async()=>{
            const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const manifest=dictionaryManifest();
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Post-download verification fetched data')},
                responseClass:Response,streamClass:TransformStream});
            const status=await store.status(manifest);
            const verified=await store.verifyAndPruneCorrupt(manifest);
            const permission=await browser.permissions.contains({
                origins:[new URL(manifest.assets[0].url).origin+'/*']});
            return {status,verified,permission,
                actualHostFetches:(window.wrappedJSObject||window).__dictionaryUiRealFetches};
        })().then(done,e=>done({error:String(e)}));
    """)
    status = installed.get("status") or {}
    verified = installed.get("verified") or {}
    if (not installed.get("permission") or installed.get("actualHostFetches") != 1 or
            not status.get("ready") or status.get("storedBytes") != status.get("totalBytes") or
            not verified.get("ready") or verified.get("removedAssets") != 0):
        raise RuntimeError("Firefox UI retry permission/fetch/SHA-256 failed: " + str(installed))
    driver.find_element(By.CSS_SELECTOR, row + " .model-remove").click()
    WebDriverWait(driver, 30).until(
        lambda d: "Not installed" in
        d.find_element(By.CSS_SELECTOR, row + " .model-status").text
        and not d.find_element(By.CSS_SELECTOR, row + " .model-remove").is_enabled()
        and d.find_element(By.CSS_SELECTOR, button).is_enabled()
    )
    removed = driver.execute_async_script("""
        const done=arguments[arguments.length-1];
        (async()=>{
            const [{ModelDataStore},{dictionaryManifest}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Removal unexpectedly fetched data')},
                responseClass:Response,streamClass:TransformStream});
            return store.status(dictionaryManifest());
        })().then(done,e=>done({error:String(e)}));
    """)
    if removed.get("ready") or removed.get("storedBytes") != 0 or removed.get("error"):
        raise RuntimeError("Firefox UI Remove left dictionary data: " + str(removed))
    driver.execute_script("""
        const page=window.wrappedJSObject||window;
        if(typeof page.__dictionaryUiOriginalFetch!=='function')
            throw Error('Lost page native fetch');
        page.fetch=page.__dictionaryUiOriginalFetch;
        delete page.__dictionaryUiOriginalFetch;
    """)
    return {"success": True, "browser": "firefox",
            "cancelledStalledDownload": True, "cacheEmptyAfterCancel": True,
            "realOfficialHttpsRetryFetches": installed["actualHostFetches"],
            "narrowHostPermissionGranted": installed["permission"],
            "fullPinnedBytes": status["totalBytes"],
            "sha256VerifiedAfterUiRetry": True,
            "uiProgressReached100": True, "uiRemoveClearedCache": True}


def wait_for_real_download_completion(driver, row, timeout, label):
    """Wait for explicit Download to finish or fail; do not approve permissions."""
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: (
                ("Installed" in d.find_element(
                    By.CSS_SELECTOR, row + " .model-status").text
                 and d.find_element(
                    By.CSS_SELECTOR, row + " .model-download-progress"
                 ).get_attribute("value") == "100")
                or any(word in d.find_element(
                    By.CSS_SELECTOR, row + " .model-status").text.lower()
                    for word in ("permission was denied", "permission failed",
                                 "cannot request", "download failed"))
            )
        )
    except Exception as exc:
        status = driver.find_element(By.CSS_SELECTOR, row + " .model-status").text
        raise RuntimeError("Firefox " + label +
                           " download UI did not complete (permission or transfer): " +
                           status) from exc
    status = driver.find_element(By.CSS_SELECTOR, row + " .model-status").text
    if "Installed" not in status:
        raise RuntimeError("Firefox " + label + " download UI failed: " + status)
    return status


def restore_onnx_dictionary_from_real_ui(driver):
    """Install the pinned dictionary by an explicit Firefox UI click.

    The preceding Download/Cancel/Retry/Remove dictionary test finishes with
    an empty cache. ONNX English synthesis requires the dictionary installed.
    """
    row = '[data-variant="dictionary-english"]'
    WebDriverWait(driver, 30).until(
        lambda d: "Not installed" in d.find_element(
            By.CSS_SELECTOR, row + " .model-status").text
        and d.find_element(By.CSS_SELECTOR, row + " .model-download").is_enabled()
    )
    driver.find_element(By.CSS_SELECTOR, row + " .model-download").click()
    wait_for_real_download_completion(driver, row, 180, "dictionary")

    report = driver.execute_async_script("""
        const done=arguments[arguments.length-1];
        (async()=>{
            const [{ModelDataStore,formatModelSize},{dictionaryManifest}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const manifest=dictionaryManifest();
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Dictionary check unexpectedly fetched')},
                responseClass:Response,streamClass:TransformStream});
            const status=await store.status(manifest);
            const verified=await store.verifyAndPruneCorrupt(manifest);
            const row=document.querySelector('[data-variant="dictionary-english"]');
            const permission=await browser.permissions.contains({
                origins:[new URL(manifest.assets[0].url).origin+'/*']});
            return {ready:status.ready,storedBytes:status.storedBytes,
                expectedBytes:status.totalBytes,
                verified:verified.ready&&verified.removedAssets===0&&
                    verified.missingAssets===0,
                permission,displayedSizeMatchesManifest:row.querySelector(
                    '.model-status').textContent.includes(formatModelSize(
                        status.totalBytes))};
        })().then(done,e=>done({error:String(e)}));
    """)
    if (report.get("error") or not report.get("ready") or
            not report.get("verified") or not report.get("permission") or
            not report.get("displayedSizeMatchesManifest") or
            report.get("storedBytes") != report.get("expectedBytes") or
            report.get("expectedBytes") != 3618488):
        raise RuntimeError("Firefox restored dictionary integrity failed: " + str(report))
    return report


class FirefoxOriginModelVerificationError(RuntimeError):
    """Preserve structured verification evidence when a full-model gate fails."""

    def __init__(self, report):
        self.report = report
        super().__init__(
            "Firefox official-origin model verification failed: " +
            json.dumps(report, sort_keys=True))


def run_model_origin_ui_acceptance(driver, manifest):
    """Real Firefox model-manager Download with pinned HTTPS data, not loopback preload.

    The hook is installed in the extension's actual page window. Firefox
    Marionette's per-command sandbox must not silently conceal transfer counts.
    """
    provider = manifest["provider"]
    variant = manifest["variant"]
    if (provider, variant) not in (("mediapipe", "cpu"), ("onnx", "q8")):
        raise ValueError("Origin acceptance supports MediaPipe CPU and ONNX q8")
    row = f'[data-variant="{provider}-{variant}"]'
    expected_urls = [asset["url"] for asset in manifest["assets"]]
    stalled_voice_url = expected_urls[1] if provider == "onnx" else None
    # Do not let a stale cached install pass without any actual upstream fetch.
    prior = driver.execute_async_script("""
        const [provider,variant,done]=arguments;
        (async()=>{
            const [{ModelDataStore},{manifestForVariant}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Unexpected fetch during origin cache reset')},
                responseClass:Response,streamClass:TransformStream});
            await store.remove(manifestForVariant(provider,variant));
            const otherProvider=provider==='onnx'?'mediapipe':'onnx';
            const variants=provider==='onnx'?['cpu','gpu']:['q8','q8f16'];
            return Promise.all(variants.map(async v=>({
                variant:v,...await store.status(manifestForVariant(otherProvider,v))})));
        })().then(value=>done({success:true,otherProviderBefore:value}),
            e=>done({success:false,error:String(e)}));
    """, provider, variant)
    if not prior.get("success"):
        raise RuntimeError("Firefox model origin reset failed: " + str(prior))
    driver.refresh()
    WebDriverWait(driver, 30).until(
        lambda d: "Not installed" in d.find_element(
            By.CSS_SELECTOR, row + " .model-status").text
        and d.find_element(By.CSS_SELECTOR, row + " .model-download").is_enabled()
    )
    driver.execute_script("""
        const page=window.wrappedJSObject||window;
        const expected=new Set(arguments[0]);
        const stallUrl=arguments[1];
        page.__originModelStallVoice=!!stallUrl;
        const original=page.fetch;
        if(typeof original!=='function')throw Error('Missing native model fetch');
        const stats={requests:[],bytesByUrl:{},completed:[],unexpected:[]};
        page.__originModelOriginalFetch=original;
        // Marionette's later commands use a different JS sandbox. Return a
        // primitive JSON snapshot through an exported page function instead
        // of exposing a cross-compartment mutable object to that sandbox.
        const snapshot=()=>JSON.stringify(stats);
        if(typeof exportFunction==='function')
            exportFunction(snapshot,page,{defineAs:'__originModelStatsJson'});
        else page.__originModelStatsJson=snapshot;
        const counted=async(input,options)=>{
            const url=String(input?.url||input);
            if(/^https?:/i.test(url)&&!expected.has(url)){
                stats.unexpected.push(url);
                throw Error('Unpinned HTTP(S) model fetch: '+url);
            }
            if(!expected.has(url))return original.apply(page,[input,options]);
            stats.requests.push(url);
            if(url===stallUrl && page.__originModelStallVoice){
                return new Promise((resolve,reject)=>{
                    const abort=()=>reject(new page.DOMException('Download aborted','AbortError'));
                    if(options?.signal?.aborted)abort();
                    else options?.signal?.addEventListener('abort',abort,{once:true});
                });
            }
            const response=await original.apply(page,[input,options]);
            if(!response.ok||!response.body)return response;
            stats.bytesByUrl[url]=0;
            const body=response.body.pipeThrough(new page.TransformStream({
                transform(chunk,controller){
                    stats.bytesByUrl[url]+=chunk.byteLength;
                    controller.enqueue(chunk);
                },
                flush(){stats.completed.push(url)}
            }));
            return new page.Response(body,{status:response.status,
                statusText:response.statusText,headers:response.headers});
        };
        if(typeof exportFunction==='function')
            exportFunction(counted,page,{defineAs:'fetch'});
        else page.fetch=counted;
        if(typeof page.fetch!=='function')
            throw Error('Model download fetch instrumentation unavailable');
    """, expected_urls, stalled_voice_url)
    button = row + " .model-download"
    driver.find_element(By.CSS_SELECTOR, button).click()

    cancelled_retry = None
    if provider == "onnx":
        # ONNX contains a 92-MB graph followed by a ~0.5-MB voice embedding.
        # Stall only the voice fetch, then Cancel via the real UI. A partial
        # install must preserve the previously verified graph, not silently
        # restart it when the user explicitly retries.
        try:
            WebDriverWait(driver, 480).until(
                lambda d: (
                    (stalled_voice_url in json.loads(d.execute_script(
                        "return (window.wrappedJSObject||window).__originModelStatsJson()"
                    ))["requests"]
                     and d.find_element(By.CSS_SELECTOR, button).text ==
                     "Cancel download")
                    or any(word in d.find_element(
                        By.CSS_SELECTOR, row + " .model-status").text.lower()
                        for word in ("permission was denied", "permission failed",
                                     "cannot request", "download failed"))
                )
            )
        except Exception as exc:
            ui = driver.find_element(By.CSS_SELECTOR, row + " .model-status").text
            raise RuntimeError("Firefox ONNX voice-stall acceptance did not "
                               "reach cancellable second asset: " + ui) from exc
        if driver.find_element(By.CSS_SELECTOR, button).text != "Cancel download":
            raise RuntimeError("Firefox ONNX first Download/permission failed: " +
                               driver.find_element(By.CSS_SELECTOR,
                                                   row + " .model-status").text)
        driver.find_element(By.CSS_SELECTOR, button).click()
        WebDriverWait(driver, 60).until(
            lambda d: "Download cancelled" in d.find_element(
                By.CSS_SELECTOR, row + " .model-status").text
            and d.find_element(By.CSS_SELECTOR, button).is_enabled()
            and d.find_element(By.CSS_SELECTOR, button).text.startswith("Download")
            and d.find_element(By.CSS_SELECTOR, row + " .model-download-progress")
                .get_attribute("hidden") is not None
        )
        cancelled_retry = driver.execute_async_script("""
            const done=arguments[arguments.length-1];
            (async()=>{
                const [{ModelDataStore},{manifestForVariant}]=await Promise.all([
                    import('./model-data-store.js'),import('./model-catalog.js')]);
                const store=new ModelDataStore({
                    origin:browser.runtime.getURL('/'),cacheStorage:caches,
                    fetchImpl:()=>{throw Error('Cancel unexpectedly fetched model')},
                    responseClass:Response,streamClass:TransformStream});
                const m=manifestForVariant('onnx','q8');
                const status=await store.status(m);
                const verified=await store.verifyAndPruneCorrupt(m);
                return {status,verified};
            })().then(done,e=>done({error:String(e)}));
        """)
        graph_bytes = manifest["assets"][0]["bytes"]
        status = cancelled_retry.get("status") or {}
        verified = cancelled_retry.get("verified") or {}
        if (cancelled_retry.get("error") or status.get("ready") or
                status.get("storedBytes") != graph_bytes or
                verified.get("ready") or verified.get("removedAssets") != 0 or
                verified.get("missingAssets") != 1):
            raise RuntimeError("Firefox ONNX Cancel failed to retain only the "
                               "verified graph: " + str(cancelled_retry))
        driver.execute_script("""
            const page=window.wrappedJSObject||window;
            if(typeof page.__originModelStatsJson!=='function')
                throw Error('Origin fetch counters missing before Retry');
            page.__originModelStallVoice=false;
        """)
        driver.find_element(By.CSS_SELECTOR, button).click()

    # Headless permission refusal must fail visibly; Selenium cannot grant it.
    ui_status = wait_for_real_download_completion(driver, row, 480, provider)

    report = driver.execute_async_script("""
        const [provider,variant,done]=arguments;
        (async()=>{
            const [{ModelDataStore,formatModelSize},{manifestForVariant,dictionaryManifest}]=await Promise.all([
                import('./model-data-store.js'),import('./model-catalog.js')]);
            const manifest=manifestForVariant(provider,variant);
            const store=new ModelDataStore({
                origin:browser.runtime.getURL('/'),cacheStorage:caches,
                fetchImpl:()=>{throw Error('Verification unexpectedly fetched model')},
                responseClass:Response,streamClass:TransformStream});
            const status=await store.status(manifest);
            // The previous real Firefox MediaPipe run stored the exact pinned
            // byte count but reported fullSha256Verified:false. Capture a
            // bounded-memory, non-destructive SHA-256 diagnosis BEFORE the
            // user-facing verifier may prune a genuinely corrupt cache entry.
            // Never accept the diagnostic digest as a substitute for the real
            // ModelDataStore.verifyAndPruneCorrupt() integrity gate.
            let cachedModelDigestDiagnostic=null;
            if(manifest.assets.some(asset=>asset.path.endsWith('.litertlm'))){
                try{
                    const asset=manifest.assets.find(a=>a.path.endsWith('.litertlm'));
                    const cache=await caches.open('kokoro-model-data-v1');
                    const entry=await cache.match(store.key(manifest,asset));
                    cachedModelDigestDiagnostic={
                        entryFound:!!entry,
                        metadataMatches:store.isCurrent(entry,asset),
                    };
                    if(entry){
                        const {IncrementalSha256}=await import('./sha256-stream.js');
                        const blob=await entry.blob();
                        const reader=blob.stream().getReader();
                        const hasher=new IncrementalSha256();
                        let chunks=0,nonUint8Chunks=0;
                        let firstChunkLength=null;
                        try{
                            for(;;){
                                const {done,value}=await reader.read();
                                if(done)break;
                                if(!ArrayBuffer.isView(value)||typeof value.byteLength!=='number'){
                                    throw Error('Cached Blob yielded non-byte stream chunk');
                                }
                                if(!(value instanceof Uint8Array))nonUint8Chunks++;
                                const bytes=new Uint8Array(
                                    value.buffer,value.byteOffset,value.byteLength);
                                firstChunkLength??=bytes.byteLength;
                                hasher.update(bytes);
                                chunks++;
                            }
                        }finally{
                            reader.releaseLock();
                        }
                        const actual='sha256-'+btoa(String.fromCharCode(...hasher.digest()));
                        Object.assign(cachedModelDigestDiagnostic,{
                            blobBytes:blob.size,bytesHashed:hasher.totalBytes,
                            chunks,nonUint8Chunks,firstChunkLength,
                            computedSha256:actual,expectedSha256:asset.integrity,
                            digestMatchesPinned:actual===asset.integrity,
                        });
                    }
                }catch(error){
                    cachedModelDigestDiagnostic={error:String(error)};
                }
            }
            const verified=await store.verifyAndPruneCorrupt(manifest);
            const afterVerification=await store.status(manifest);
            const page=window.wrappedJSObject||window;
            if(typeof page.__originModelStatsJson!=='function')
                throw Error('Lost real Firefox page transfer counters');
            const stats=JSON.parse(page.__originModelStatsJson());
            const urls=manifest.assets.map(a=>a.url);
            const expectedBytes=manifest.assets.reduce((n,a)=>n+a.bytes,0);
            const receivedBytes=urls.reduce(
                (n,url)=>n+(stats.bytesByUrl[url]||0),0);
            const otherProvider=provider==='onnx'?'mediapipe':'onnx';
            const otherVariants=provider==='onnx'?['cpu','gpu']:['q8','q8f16'];
            const otherProviderAfter=await Promise.all(otherVariants.map(
                async v=>({variant:v,...await store.status(
                    manifestForVariant(otherProvider,v))})));
            const dictionary=provider==='onnx'
                ? await store.verifyAndPruneCorrupt(dictionaryManifest()) : null;
            const row=document.querySelector('[data-variant="'+provider+'-'+variant+'"]');
            const permission=await browser.permissions.contains({
                origins:[new URL(urls[0]).origin+'/*']});
            return {
                success:true,provider,variant,permission,
                expectedBytes,receivedBytes,cachedBytes:status.storedBytes,
                pinnedAssets:manifest.assets.map(a=>({path:a.path,bytes:a.bytes})),
                requests:stats.requests,completedUrls:stats.completed,
                unexpectedUrls:stats.unexpected,
                fullSha256Verified:verified.ready&&verified.removedAssets===0&&
                    verified.missingAssets===0,
                sha256Verification:verified,
                statusAfterVerification:afterVerification,
                cachedModelDigestDiagnostic,
                progressPercent:row.querySelector('.model-download-progress').value,
                displayedSizeMatchesManifest:row.querySelector('.model-download')
                    .textContent.includes(formatModelSize(expectedBytes))&&
                    row.querySelector('.model-status').textContent
                        .includes(formatModelSize(expectedBytes)),
                otherProviderAfter,
                dictionaryIntegrityVerified:dictionary?
                    dictionary.ready&&dictionary.removedAssets===0&&
                    dictionary.missingAssets===0:null,
            };
        })().then(done,e=>done({success:false,error:String(e)}));
    """, provider, variant)
    expected_bytes = sum(a["bytes"] for a in manifest["assets"])
    expected_requests = ([expected_urls[0], expected_urls[1], expected_urls[1]]
                         if provider == "onnx" else expected_urls)
    if (not report.get("success") or not report.get("permission") or
            not report.get("fullSha256Verified") or
            not report.get("displayedSizeMatchesManifest") or
            report.get("expectedBytes") != expected_bytes or
            report.get("receivedBytes") != expected_bytes or
            report.get("cachedBytes") != expected_bytes or
            report.get("progressPercent") != 100 or
            report.get("requests") != expected_requests or
            report.get("unexpectedUrls") or
            sorted(report.get("completedUrls", [])) != sorted(expected_urls) or
            report.get("otherProviderAfter") != prior["otherProviderBefore"] or
            (provider == "onnx" and not report.get("dictionaryIntegrityVerified"))):
        raise FirefoxOriginModelVerificationError(report)
    report["otherProviderBefore"] = prior["otherProviderBefore"]
    if cancelled_retry:
        report["cancelRetry"] = {
            "cancelledDuringSecondAsset": True,
            "verifiedFirstAssetPreserved": True,
            "missingAssetCountAfterCancel": 1,
            "explicitRetryFetchedOnlyMissingVoice": True,
            "requestsBeforeAndAfterRetry": report["requests"],
        }
    return report



def _open_persistent_firefox(profile, quota_limit_kib=None):
    options = Options()
    options.binary_location = os.environ["FIREFOX_BINARY"]
    options.add_argument("-headless")
    options.add_argument("-profile")
    options.add_argument(str(profile))
    options.set_preference("xpinstall.signatures.required", False)
    if quota_limit_kib is not None:
        # Real Gecko QuotaManager pref, in KiB; applied only to an isolated
        # Developer Edition profile used by the manual Firefox quota test.
        if quota_limit_kib not in (8192, 131072):
            raise ValueError("Unexpected Firefox quota-test limit")
        options.set_preference("dom.quotaManager.temporaryStorage.fixedLimit",
                               quota_limit_kib)
    # Geckodriver 0.37.1 requires this explicit flag for CHROME-context
    # AddonManager/Services checks; Firefox browser arguments are insufficient.
    service = FirefoxService(service_args=["--allow-system-access"])
    browser = webdriver.Firefox(options=options, service=service)
    browser.set_script_timeout(250)
    # Geckodriver exposes the effective on-disk profile. Refuse a silently
    # cloned/temporary profile: it would make the restart test meaningless.
    effective_profile = browser.capabilities.get("moz:profile")
    if (not effective_profile or
            Path(effective_profile).resolve() != Path(profile).resolve()):
        browser.quit()
        raise RuntimeError("Firefox did not reuse the requested persistent profile")
    if not isinstance(browser.capabilities.get("moz:processID"), int):
        browser.quit()
        raise RuntimeError("Firefox parent-process PID unavailable")
    return browser

def _persistent_firefox_extension_origin(browser, addon_id):
    browser.set_context("chrome")
    try:
        mapping = json.loads(browser.execute_script(
            "return Services.prefs.getStringPref("
            "'extensions.webextensions.uuids', '{}');"
        ))
        unsigned_allowed = browser.execute_script(
            "return Services.prefs.getBoolPref('xpinstall.signatures.required');"
        ) is False
    finally:
        browser.set_context("content")
    if not unsigned_allowed:
        raise RuntimeError("Firefox profile still enforces signed XPI files")
    if not mapping.get(addon_id):
        raise RuntimeError("Installed extension lacks a stable moz-extension UUID")
    return "moz-extension://" + mapping[addon_id]


def _pinned_firefox_handler(files, token, state):
    from urllib.parse import parse_qs

    class PinnedTransfer(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlsplit(self.path)
            if (self.command != "GET" or
                    parse_qs(url.query).get("token") != [token] or
                    self.client_address[0] != "127.0.0.1" or
                    not state["origin"] or
                    (self.headers.get("Origin") and
                     self.headers["Origin"] != state["origin"])):
                self.send_error(403)
                return
            item = files.get(url.path.removeprefix("/"))
            if not item:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", state["origin"])
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(item.stat().st_size))
            self.end_headers()
            with item.open("rb") as data:
                while piece := data.read(1024 * 1024):
                    self.wfile.write(piece)

        def log_message(self, *args):
            return
    return PinnedTransfer



def _firefox_actual_quota_pref(browser):
    browser.set_context("chrome")
    try:
        return browser.execute_script(
            "return Services.prefs.getIntPref("
            "'dom.quotaManager.temporaryStorage.fixedLimit', -1);"
        )
    finally:
        browser.set_context("content")


def run_firefox_quota_acceptance():
    """Manual quota pressure against real Cache Storage across Firefox restarts.

    A reduced Firefox QuotaManager global limit forces a second-asset write
    failure; a process restart with a restored cap permits explicit retry.
    Neither Firefox StorageManager nor Cache Storage is mocked.
    """
    from zipfile import ZipFile

    output = Path("dist/runtime-acceptance/firefox-quota.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {
        "status": "started", "scope": "firefox-real-quota-recovery",
        "syntheticAssetsOnly": True, "fullModelDownloaded": False,
        "browserQuotaFailureVerified": False,
        "browserManagedEvictionClaimed": False,
    }
    driver = None
    # Separate on-disk profile; never modify the user's Firefox settings,
    # quota limits or cache. The entire directory is removed on exit.
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-quota-") as temp:
        profile = Path(temp) / "profile"
        profile.mkdir()
        (profile / "user.js").write_text(
            'user_pref("xpinstall.signatures.required", false);\n'
            'user_pref("extensions.autoDisableScopes", 0);\n',
            encoding="utf-8",
        )
        try:
            version = json.loads(Path("package.json").read_text(encoding="utf-8"))["version"]
            package = (Path("dist/package") /
                       f"kokoro-extension-firefox-{version}.zip").resolve()
            if not package.is_file():
                raise FileNotFoundError("Packaged Firefox XPI missing: " + str(package))
            with ZipFile(package) as archive:
                expected_id = json.loads(archive.read("manifest.json"))[
                    "browser_specific_settings"]["gecko"]["id"]
            probe_source = Path("scripts/firefox-quota-probe.js").read_text(encoding="utf-8")
            # Selenium supplies `arguments` when it wraps execute_async_script;
            # the standalone probe stays lint-clean and accepts just a phase.
            probe = probe_source + """
                const done=arguments[arguments.length-1];
                globalThis.runFirefoxQuotaProbe(arguments[0])
                    .then(report => done({success: true, ...report}),
                        error => done({
                            success: false,
                            error: String(error?.message || error),
                            stack: String(error?.stack || ''),
                            details: error?.details || null
                        }));
            """
            driver = _open_persistent_firefox(profile, quota_limit_kib=8192)
            first_pid = driver.capabilities["moz:processID"]
            if _firefox_actual_quota_pref(driver) != 8192:
                raise RuntimeError("Firefox did not activate the restrictive quota preference")
            installed_id = driver.install_addon(str(package), temporary=False)
            if installed_id != expected_id:
                raise RuntimeError("Firefox permanent add-on identity mismatch")
            extension_origin = _persistent_firefox_extension_origin(driver, installed_id)
            driver.get(extension_origin + "/benchmark.html")
            WebDriverWait(driver, 30).until(
                lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            limited = driver.execute_async_script(probe, "limited")
            result["limited"] = limited
            if not limited.get("success"):
                raise RuntimeError("Real Firefox limited-quota phase failed: " +
                                   str(limited.get("error")))
            # Firefox StorageManager.estimate().quota is an *origin* estimate,
            # not the global QuotaManager fixedLimit. It can legitimately be
            # much larger than the test cap; only the real Cache Storage
            # QuotaExceededError plus preserved checksummed bytes prove this.
            if (limited.get("modelBytes", 0) <= 8192 * 1024 or
                    not limited.get("dictionaryPreserved")):
                raise RuntimeError("Firefox quota recovery fixture did not exceed the global cap")
            result["browserQuotaFailureVerified"] = True
            result["initialProcessId"] = first_pid
            result["extensionId"] = installed_id
            result["extensionOrigin"] = extension_origin

            driver.quit()
            driver = None
            # A different parent process must load the SAME installed add-on
            # and profile; unlike a preference-only JS stub this resets Gecko's
            # quota manager with the new capacity.
            driver = _open_persistent_firefox(profile, quota_limit_kib=131072)
            second_pid = driver.capabilities["moz:processID"]
            if second_pid == first_pid:
                raise RuntimeError("Firefox did not restart its parent process")
            if _firefox_actual_quota_pref(driver) != 131072:
                raise RuntimeError("Firefox did not restore the quota preference")
            if _persistent_firefox_extension_origin(driver, installed_id) != extension_origin:
                raise RuntimeError("Firefox lost the installed extension after quota reset")
            driver.get(extension_origin + "/benchmark.html")
            WebDriverWait(driver, 30).until(
                lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            driver.set_context("chrome")
            try:
                network_disabled = driver.execute_script("""
                    Services.io.manageOfflineStatus=false;
                    Services.io.offline=true;
                    return Services.io.offline;
                """)
            finally:
                driver.set_context("content")
            if not network_disabled or not driver.execute_script(
                    "return navigator.onLine === false"):
                raise RuntimeError("Firefox was not network-offline before retry")
            recovered = driver.execute_async_script(probe, "recovery")
            result["recovery"] = recovered
            if not recovered.get("success"):
                raise RuntimeError("Real Firefox relaxed-quota retry failed: " +
                                   str(recovered.get("error")))
            # The global QuotaManager preference was checked above; do not
            # infer that it changed from the per-origin StorageManager estimate.
            result.update({
                "status": "passed",
                "restartedProcessId": second_pid,
                "browserProcessRestarted": True,
                "networkOfflineDuringRetry": True,
                "explicitRetryFetchedOnlyMissingAsset": True,
                "dictionaryPreserved": True,
            })
            print("FIREFOX REAL-QUOTA ACCEPTANCE", json.dumps(result), flush=True)
        except Exception as exc:
            result["status"] = "failed"
            result["error"] = str(exc)
            raise
        finally:
            output.write_text(json.dumps(result, indent=2), encoding="utf-8")
            if driver:
                driver.quit()


def run_permanent_addon_restart_acceptance():
    """Manual-only real Firefox process restart using an installed XPI and profile.

    Unsigned packaged add-ons require Firefox Developer Edition (or Nightly).
    The explicit profile path is reused by two separate browser processes.
    """
    from zipfile import ZipFile

    if os.environ.get("KOKORO_LIVE_DOWNLOAD") != "1":
        raise RuntimeError("Persistent Firefox acceptance requires explicit opt-in")

    output = Path("dist/runtime-acceptance/firefox.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"status": "started", "browser": "Firefox Developer Edition",
              "scope": "persistent-installed-addon-process-restart",
              "browserProcessRestarted": False, "temporaryAddon": False,
              "offlineAttempted": False}
    driver = None
    server = None
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-persistent-") as tmp:
        directory = Path(tmp)
        profile = directory / "profile"
        profile.mkdir()
        # Using -profile rather than options.profile prevents Selenium from
        # cloning the profile into a throwaway directory on each new session.
        # On supported developer-channel binaries, disable unsigned-XPI checks.
        (profile / "user.js").write_text(
            'user_pref("xpinstall.signatures.required", false);\n'
            'user_pref("extensions.autoDisableScopes", 0);\n',
            encoding="utf-8",
        )

        try:
            manifests = pinned_manifest("onnx")
            files = {}
            for manifest in manifests:
                files.update(verified_assets(manifest, directory))
            expected_bytes = sum(asset["bytes"] for manifest in manifests
                                 for asset in manifest["assets"])
            version = json.loads(Path("package.json").read_text(encoding="utf-8"))["version"]
            package = (Path("dist/package") /
                       f"kokoro-extension-firefox-{version}.zip").resolve()
            if not package.is_file():
                raise FileNotFoundError("Packaged Firefox add-on missing: " + str(package))
            with ZipFile(package) as archive:
                gecko_id = json.loads(archive.read("manifest.json"))[
                    "browser_specific_settings"]["gecko"]["id"]

            state = {"origin": None}
            token = secrets.token_hex(32)

            server = http.server.ThreadingHTTPServer(
                ("127.0.0.1", 0), _pinned_firefox_handler(files, token, state))
            threading.Thread(target=server.serve_forever, daemon=True).start()

            driver = _open_persistent_firefox(profile)
            first_pid = driver.capabilities["moz:processID"]
            # Explicitly persistent: temporary=True would be unloaded on exit.
            addon_id = driver.install_addon(str(package), temporary=False)
            if addon_id != gecko_id:
                raise RuntimeError("Firefox permanent XPI ID disagrees with manifest")
            state["origin"] = _persistent_firefox_extension_origin(driver, addon_id)
            initial_origin = state["origin"]
            driver.get(initial_origin + "/benchmark.html")
            WebDriverWait(driver, 30).until(
                lambda b: b.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            installed = driver.execute_async_script("""
                const [manifests,port,token,done]=arguments;
                (async()=>{
                    const {ModelDataStore}=await import('./model-data-store.js');
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:fetch,responseClass:Response,streamClass:TransformStream
                    });
                    const cache=await caches.open('kokoro-model-data-v1');
                    const statuses=[];
                    for(const m of manifests){
                        for(const asset of m.assets){
                            const bytes=Uint8Array.from(atob(asset.integrity.slice(7)),
                                c=>c.charCodeAt(0));
                            const hash=Array.from(bytes).map(
                                b=>b.toString(16).padStart(2,'0')).join('');
                            const res=await fetch(
                                'http://127.0.0.1:'+port+'/'+hash+'?token='+token);
                            if(!res.ok||!res.body)
                                throw Error('Pinned local asset handoff HTTP '+res.status);
                            await cache.put(store.key(m,asset),new Response(res.body,{
                                headers:{'x-kokoro-integrity':asset.integrity,
                                         'x-kokoro-bytes':String(asset.bytes)}
                            }));
                        }
                        const verified=await store.verifyAndPruneCorrupt(m);
                        const status=await store.status(m);
                        if(!verified.ready||verified.removedAssets||
                            verified.missingAssets||!status.ready||
                            status.storedBytes!==status.totalBytes)
                            throw Error('Pre-restart pinned asset integrity failed');
                        statuses.push({provider:m.provider,variant:m.variant,
                            verified:true,storedBytes:status.storedBytes});
                    }
                    done({success:true,statuses});
                })().catch(e=>done({success:false,error:String(e)}));
            """, manifests, server.server_port, token)
            if not installed.get("success") or sum(
                    item["storedBytes"] for item in installed.get("statuses", [])) != expected_bytes:
                raise RuntimeError("Installed Firefox model/dictionary cache invalid: " +
                                   str(installed))
            result["initialProcessId"] = first_pid
            result["extensionId"] = addon_id
            result["extensionOrigin"] = initial_origin
            result["cacheBeforeRestart"] = installed["statuses"]
            # Quit the real parent browser process, not merely its document.
            driver.quit()
            driver = None

            driver = _open_persistent_firefox(profile)
            second_pid = driver.capabilities["moz:processID"]
            if second_pid == first_pid:
                raise RuntimeError("Firefox reused the previous parent-process PID")
            persisted_origin = _persistent_firefox_extension_origin(driver, addon_id)
            if persisted_origin != initial_origin:
                raise RuntimeError("Firefox changed extension UUID across process restart")
            driver.get(persisted_origin + "/benchmark.html")
            WebDriverWait(driver, 30).until(
                lambda b: b.execute_script("return Boolean(window.KokoroBenchmark)")
            )
            result["restartedProcessId"] = second_pid
            result["browserProcessRestarted"] = True
            driver.set_context("chrome")
            try:
                went_offline = driver.execute_script("""
                    Services.io.manageOfflineStatus=false;
                    Services.io.offline=true;
                    return Services.io.offline;
                """)
            finally:
                driver.set_context("content")
            if not went_offline or not driver.execute_script(
                    "return navigator.onLine===false;"):
                raise RuntimeError("Firefox failed to disable network after restart")
            result["offlineAttempted"] = True
            checked = driver.execute_async_script("""
                const [manifests,done]=arguments;
                (async()=>{
                    if(navigator.onLine!==false)
                        throw Error('Browser must be offline before cache checks');
                    const [{ModelDataStore},{OnnxKokoroProvider}]=await Promise.all([
                        import('./model-data-store.js'),import('./onnx-provider.js')]);
                    const store=new ModelDataStore({
                        origin:browser.runtime.getURL('/'),cacheStorage:caches,
                        fetchImpl:()=>{throw Error('Unapproved network fetch after restart')},
                        responseClass:Response,streamClass:TransformStream});
                    const statuses=[];
                    for(const m of manifests){
                        const before=await store.status(m);
                        const verification=await store.verifyAndPruneCorrupt(m);
                        const after=await store.status(m);
                        if(!before.ready||!verification.ready||!after.ready||
                            verification.removedAssets||verification.missingAssets||
                            before.storedBytes!==after.storedBytes)
                            throw Error('Cached model or dictionary failed after restart');
                        statuses.push({provider:m.provider,variant:m.variant,
                            verified:true,storedBytes:after.storedBytes});
                    }
                    const engine=new OnnxKokoroProvider({variant:'q8'});
                    try{
                        await engine.initialize();
                        const audio=await engine.synthesize('Hello world.');
                        const sampleRate=audio.sampleRateHz;
                        const duration=audio.samples.length/sampleRate;
                        const rms=Math.sqrt(audio.samples.reduce(
                            (n,v)=>n+v*v,0)/audio.samples.length);
                        if(sampleRate!==24000||!(duration>=0.2&&duration<=30)||
                            !(rms>0.0001)||!audio.samples.every(Number.isFinite))
                            throw Error('Invalid offline ONNX English-dictionary audio');
                        done({success:true,statuses,offlineSynthesis:{
                            sampleRateHz:sampleRate,durationSec:duration,rms}});
                    }finally{await engine.close()}
                })().catch(e=>done({success:false,error:String(e)}));
            """, manifests)
            if (not checked.get("success") or
                    checked.get("statuses") != installed["statuses"]):
                raise RuntimeError("Firefox restart persistence or offline inference failed: " +
                                   str(checked))
            result.update({"status": "passed", "cacheAfterRestart": checked["statuses"],
                           "offlineInference": True,
                           "offlineSynthesis": checked["offlineSynthesis"],
                           "noAutomaticRedownload": True,
                           "sameExtensionOrigin": True})
            print("FIREFOX PERSISTENT RESTART ACCEPTANCE", json.dumps(result), flush=True)
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
                server.server_close()



def accept_local_benchmark_ui(driver, origin, provider):
    """Exercise real packaged benchmark controls with an installed, offline model."""
    variant = "q8" if provider == "onnx" else "cpu"
    key = provider + "-" + variant
    selector = f'[data-variant="{key}"]'
    driver.get(origin + "/benchmark.html")
    WebDriverWait(driver, 30).until(
        lambda d: d.find_element(By.CSS_SELECTOR, selector + " .model-test").is_enabled()
    )

    def completed_english_row():
        return driver.execute_script("""
            const key=arguments[0];
            const model=document.querySelector('[data-variant="'+key+'"]');
            const row=document.querySelector(
                '#sharedEnglishComparisonRows tr[data-backend="'+key+'"]');
            return Boolean(row && model?.querySelector('.model-choose')?.disabled===false &&
                model?.querySelector('.model-status')?.textContent.includes(
                    'warm (3 runs, shared English text)'));
        """, key)

    def read_row():
        value = driver.execute_script("""
            const key=arguments[0];
            const row=document.querySelector(
                '#sharedEnglishComparisonRows tr[data-backend="'+key+'"]');
            const rows=document.querySelectorAll('#sharedEnglishComparisonRows tr');
            const model=document.querySelector('[data-variant="'+key+'"]');
            if(!row || rows.length!==1 ||
                !model?.querySelector('.model-status')?.textContent.includes(
                    'warm (3 runs, shared English text)') ||
                model.querySelector('.model-choose')?.disabled ||
                document.getElementById('serverStatus')?.textContent!=='Not tested' ||
                !document.getElementById('serverAudio')?.hidden ||
                navigator.onLine!==false)
                throw Error('Real Firefox local-English comparison row invalid');
            const cells=Array.from(row.cells,c=>c.textContent.trim());
            const values=cells.slice(1).map(Number.parseFloat);
            if(values.length!==3 || values.some(v=>!Number.isFinite(v)||v<=0))
                throw Error('Invalid synthesis measurements: '+JSON.stringify(cells));
            return {cells,p50Ms:values[0],p95Ms:values[1],rtfP50:values[2]};
        """, key)
        return value

    def edit_sample(text):
        return driver.execute_script("""
            const input=document.getElementById('benchmarkText');
            input.value=arguments[0];
            input.dispatchEvent(new Event('input',{bubbles:true}));
            return document.querySelectorAll('#sharedEnglishComparisonRows tr').length;
        """, text)

    if not driver.execute_script("return navigator.onLine===false;"):
        raise RuntimeError("Firefox benchmark must remain offline")
    driver.find_element(By.CSS_SELECTOR, selector + " .model-test").click()
    WebDriverWait(driver, 180).until(lambda d: completed_english_row())
    first = read_row()

    if edit_sample("zzzzqwertyword.") != 0:
        raise RuntimeError("Firefox benchmark did not clear stale results on text edit")
    ipa_only_excluded = None
    if provider == "onnx":
        driver.find_element(By.CSS_SELECTOR, selector + " .model-test").click()
        WebDriverWait(driver, 180).until(lambda d: d.execute_script("""
            const model=document.querySelector(arguments[0]);
            return model?.querySelector('.model-status')?.textContent.includes(
                'IPA-only diagnostic') &&
                model.querySelector('.model-choose')?.disabled===true;
        """, selector))
        if driver.execute_script(
                "return document.querySelectorAll('#sharedEnglishComparisonRows tr').length;") != 0:
            raise RuntimeError("Firefox ONNX IPA fallback was included in English comparison")
        ipa_only_excluded = True

    if edit_sample("Hello world.") != 0:
        raise RuntimeError("Firefox stale comparison appeared before retesting")
    driver.find_element(By.CSS_SELECTOR, selector + " .model-test").click()
    WebDriverWait(driver, 180).until(lambda d: completed_english_row())
    restored = read_row()
    return {
        "success": True, "provider": provider, "variant": variant,
        "sharedSample": "Hello world.", "first": first, "restored": restored,
        "clearedOnEdit": True, "ipaOnlyExcluded": ipa_only_excluded,
        "backendSelectionTested": True, "networkOffline": True,
        "noImplicitFastApi": True, "rows": 1,
    }



def accept_two_backend_comparison(driver, origin):
    """Measure ONNX q8 and MediaPipe CPU sequentially on one real, offline page."""
    keys = ("onnx-q8", "mediapipe-cpu")
    driver.get(origin + "/benchmark.html")
    WebDriverWait(driver, 45).until(lambda d: d.execute_script("""
        return arguments[0].every(key=>{
            const row=document.querySelector('[data-variant="'+key+'"]');
            return row?.querySelector('.model-test')?.disabled===false &&
                row?.querySelector('.model-remove')?.disabled===false;
        });
    """, list(keys)))
    if not driver.execute_script("return navigator.onLine===false;"):
        raise RuntimeError("Firefox dual comparison was not fully offline")

    def selected_backend():
        value = driver.execute_async_script("""
            const done=arguments[arguments.length-1];
            browser.storage.sync.get({ttsBackend:'fastapi'}).then(
                data=>done({backend:data.ttsBackend}),
                e=>done({error:String(e)}));
        """)
        if value.get("error"):
            raise RuntimeError("Cannot inspect selected TTS backend: " + value["error"])
        return value["backend"]

    before = selected_backend()
    measurements = []
    for key in keys:
        row_selector = f'[data-variant="{key}"]'
        driver.find_element(By.CSS_SELECTOR, row_selector + " .model-test").click()
        WebDriverWait(driver, 280).until(lambda d: d.execute_script("""
            const key=arguments[0];
            const row=document.querySelector('[data-variant="'+key+'"]');
            return row?.querySelector('.model-test')?.disabled===false &&
                row?.querySelector('.model-choose')?.disabled===false &&
                row?.querySelector('.model-status')?.textContent.includes(
                    'warm (3 runs, shared English text)') &&
                Boolean(document.querySelector(
                    '#sharedEnglishComparisonRows tr[data-backend="'+key+'"]'));
        """, key))
        measurement = driver.execute_script("""
            const key=arguments[0];
            const model=document.querySelector('[data-variant="'+key+'"]');
            const tbody=document.getElementById('sharedEnglishComparisonRows');
            const row=tbody?.querySelector('tr[data-backend="'+key+'"]');
            if(!row || !model?.querySelector('audio')?.src.startsWith('blob:') ||
                document.getElementById('serverStatus')?.textContent!=='Not tested' ||
                !document.getElementById('serverAudio')?.hidden ||
                navigator.onLine!==false)
                throw Error('Firefox dual comparison missing real offline audio/row');
            const cells=Array.from(row.cells,c=>c.textContent.trim());
            const values=cells.slice(1).map(Number.parseFloat);
            if(values.length!==3 || values.some(v=>!Number.isFinite(v)||v<=0) ||
                values[1]<values[0])
                throw Error('Invalid Firefox dual timings: '+JSON.stringify(cells));
            return {key,label:cells[0],p50Ms:values[0],p95Ms:values[1],
                rtfP50:values[2],rowCount:tbody.rows.length};
        """, key)
        measurements.append(measurement)
    if ([item["rowCount"] for item in measurements] != [1, 2]):
        raise RuntimeError("Firefox dual comparison did not retain both measured rows")

    summary = driver.execute_script("""
        const rows=[...document.querySelectorAll('#sharedEnglishComparisonRows tr')];
        const labels=rows.map(row=>row.dataset.backend);
        const summary=document.getElementById('sharedEnglishComparisonStatus')?.textContent;
        if(rows.length!==2 || new Set(labels).size!==2 ||
            !labels.includes('onnx-q8') || !labels.includes('mediapipe-cpu') ||
            !summary?.includes('Measured 2 local backend paths') ||
            !summary.includes('No ranking is inferred'))
            throw Error('Firefox dual provider rows/summary did not match expectations');
        return summary;
    """)
    remaining = driver.execute_script("""
        const text=document.getElementById('benchmarkText');
        text.value='Another shared English sample.';
        text.dispatchEvent(new Event('input',{bubbles:true}));
        return document.querySelectorAll('#sharedEnglishComparisonRows tr').length;
    """)
    if remaining != 0:
        raise RuntimeError("Firefox dual comparison retained stale rows after sample edit")
    after = selected_backend()
    if after != before:
        raise RuntimeError("Firefox dual comparison silently changed the selected backend")
    return {
        "success": True, "providers": list(keys), "sharedSample": "Hello world.",
        "measurements": measurements, "rowsBeforeEdit": 2, "rowsAfterEdit": 0,
        "bothRetainedOnOnePage": True, "backendSelectionUnchanged": True,
        "selectedBackend": after, "networkOffline": True,
        "serverTestNotTriggered": True, "noAutomaticRanking": True, "summary": summary,
    }


# Browser-side readiness poll kept as one string so CodeFactor scores the
# Python orchestration helpers, not the embedded Chromium-parity JS.
_EPUB_CHAPTER_READY_SCRIPT = """
const [title, previousRevision, previousAudioUrl, previousAudioSha256, backend, done] = arguments;
(async () => {
    // Keep in sync with reader_acceptance_epub.READER_ACCEPTANCE_SPEECH.
    const expectedSpeech = {
        'First Chapter': 'Hello first chapter.',
        'Second Chapter': 'Hello second chapter.',
        'acceptance.txt': 'Hello plain text.',
    }[title];
    const expectedNav = (chapterTitle) => ({
        entries: chapterTitle === 'acceptance.txt' ? 1 : 2,
        prevDisabled: chapterTitle !== 'Second Chapter',
        nextDisabled: chapterTitle !== 'First Chapter',
    });
    const collectNav = () => {
        const active = document.querySelector('.playable-chapter.active');
        return {
            activeLabel: active?.querySelector('.chapter-label')?.textContent ?? null,
            activeHref: active?.dataset.href ?? null,
            entries: [...document.querySelectorAll('.playable-chapter')].map(el => ({
                label: el.querySelector('.chapter-label')?.textContent ?? null,
                href: el.dataset.href ?? null,
                active: el.classList.contains('active'),
            })),
            prevDisabled: document.getElementById('prevChapter').disabled,
            nextDisabled: document.getElementById('nextChapter').disabled,
        };
    };
    const navMatches = (chapterTitle) => {
        const expected = expectedNav(chapterTitle);
        const active = document.querySelector('.playable-chapter.active');
        const prev = document.getElementById('prevChapter');
        const next = document.getElementById('nextChapter');
        return document.querySelectorAll('.playable-chapter').length === expected.entries &&
            active?.querySelector('.chapter-label')?.textContent === chapterTitle &&
            prev?.disabled === expected.prevDisabled &&
            next?.disabled === expected.nextDisabled;
    };
    const pendingContentMatches = (stored) => {
        const blocks = stored.pendingContent;
        return Array.isArray(blocks) && blocks.length === 1 &&
            blocks[0].content === expectedSpeech;
    };
    const shellReady = (frame, audio, status, stored, revision, audioUrl) => [
        () => Boolean(frame && audio),
        () => document.getElementById('filePickerOverlay')?.style.display === 'none',
        () => navMatches(title),
        () => stored.pendingTitle === title && stored.pendingTtsBackend === backend,
        () => stored.pendingApiUrl === null || stored.pendingApiUrl === '',
        () => stored.pendingAutoplay === false,
        () => Number.isSafeInteger(revision) && revision > previousRevision,
        () => pendingContentMatches(stored),
        () => Boolean(audioUrl?.startsWith('blob:')),
        () => !previousAudioUrl || audioUrl !== previousAudioUrl,
        () => audio.paused,
        () => frame.getElementById('loadingSpinner')?.style.display === 'none',
        () => status?.textContent !== 'Error playing audio.',
        () => frame.getElementById('pageTitle')?.textContent === title,
        () => frame.querySelectorAll('.sentence').length >= 1,
        () => navigator.onLine === false,
    ].every(check => check());
    const stillStable = (frame, audio, audioUrl) => [
        () => audio.src === audioUrl,
        () => frame.getElementById('loadingSpinner')?.style.display === 'none',
        () => frame.getElementById('pageTitle')?.textContent === title,
        () => navMatches(title),
    ].every(check => check());
    const assertValidWav = (bytes, response, audioUrl, revision, wavBackend) => {
        const tag = (offset, count) =>
            String.fromCharCode(...bytes.subarray(offset, offset + count));
        const header = bytes.byteLength >= 44
            ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
        const audioBytes = header?.getUint32(40, true) ?? 0;
        if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' &&
            header?.getUint32(24, true) === 24000 && audioBytes >= 2 &&
            bytes.length === 44 + audioBytes) {
            return audioBytes;
        }
        throw Error('Real EPUB reader WAV mismatch: ' + JSON.stringify({
            title, revision, backend: wavBackend,
            sourceKind: audioUrl.split(':', 1)[0],
            mime: response.headers.get('content-type'),
            length: bytes.length, riff: tag(0, 4), wave: tag(8, 4),
            rate: header?.getUint32(24, true) ?? null,
            audioBytes, expectedLength: 44 + audioBytes,
            leadBytes: [...bytes.subarray(0, 12)],
        }));
    };
    const sha256Hex = async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, '0')).join('');
    };
    const frame = document.getElementById('playerFrame')?.contentDocument;
    const audio = frame?.getElementById('audio');
    const status = frame?.getElementById('status');
    const stored = await browser.storage.local.get([
        'pendingTitle', 'pendingTtsBackend', 'pendingApiUrl',
        'pendingReaderReloadRevision', 'pendingContent', 'pendingAutoplay',
    ]);
    const revision = stored.pendingReaderReloadRevision;
    const audioUrl = audio?.src;
    if (!shellReady(frame, audio, status, stored, revision, audioUrl)) {
        done(false);
        return;
    }
    let response;
    let bytes;
    try {
        response = await frame.defaultView.fetch(audioUrl);
        if (!response.ok) { done(false); return; }
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
        done(false);
        return;
    }
    const latest = await browser.storage.local.get([
        'pendingReaderReloadRevision', 'pendingTitle', 'pendingTtsBackend',
    ]);
    if (latest.pendingReaderReloadRevision !== revision ||
        latest.pendingTitle !== title || latest.pendingTtsBackend !== backend ||
        !stillStable(frame, audio, audioUrl)) {
        done(false);
        return;
    }
    const audioBytes = assertValidWav(
        bytes, response, audioUrl, revision, stored.pendingTtsBackend);
    const audioSha256 = await sha256Hex(bytes);
    if (previousAudioSha256 && audioSha256 === previousAudioSha256) {
        done(false);
        return;
    }
    done({
        title, revision, audioUrl, bytes: audioBytes, audioSha256,
        expectedSpeech, pendingContent: stored.pendingContent,
        blockCount: stored.pendingContent.length,
        backend: stored.pendingTtsBackend,
        serverUrl: stored.pendingApiUrl,
        paused: audio.paused,
        nav: collectNav(),
    });
})().catch(error => done({ __error: String(error) }));
"""


def _poll_real_epub_chapter_ready(driver, title, previous_revision, previous_audio_url,
                                  previous_audio_sha256=None, backend="onnx"):
    """Atomic reader+iframe WAV readiness poll (Firefox port of Chromium helper)."""
    return driver.execute_async_script(
        _EPUB_CHAPTER_READY_SCRIPT, title, previous_revision, previous_audio_url,
        previous_audio_sha256, backend)


def _read_reader_nav_diagnostics(driver):
    return driver.execute_script("""
        const prev = document.getElementById('prevChapter');
        const next = document.getElementById('nextChapter');
        const active = document.querySelector('.playable-chapter.active');
        return {
            activeLabel: active?.querySelector('.chapter-label')?.textContent ?? null,
            activeHref: active?.dataset.href ?? null,
            entries: [...document.querySelectorAll('.playable-chapter')].map(el => ({
                label: el.querySelector('.chapter-label')?.textContent ?? null,
                href: el.dataset.href ?? null,
                active: el.classList.contains('active'),
            })),
            prevDisabled: prev?.disabled ?? null,
            nextDisabled: next?.disabled ?? null,
            prevAriaDisabled: prev?.getAttribute('aria-disabled') ?? null,
            nextAriaDisabled: next?.getAttribute('aria-disabled') ?? null,
            pageTitle: document.getElementById('playerFrame')?.contentDocument
                ?.getElementById('pageTitle')?.textContent ?? null,
            status: document.getElementById('playerFrame')?.contentDocument
                ?.getElementById('status')?.textContent ?? null,
            pickerVisible: document.getElementById('filePickerOverlay')?.style.display !== 'none',
        };
    """)


def _expected_nav_for_title(title):
    if title == "First Chapter":
        return {"prevDisabled": True, "nextDisabled": False}
    if title == "Second Chapter":
        return {"prevDisabled": False, "nextDisabled": True}
    if title == "acceptance.txt":
        return {"prevDisabled": True, "nextDisabled": True}
    return None


def _safe_reader_nav_diagnostics(driver):
    try:
        return _read_reader_nav_diagnostics(driver)
    except Exception:
        return None


def _epub_chapter_poll_result(driver, title, previous_revision, previous_audio_url,
                              previous_audio_sha256=None, backend="onnx"):
    """Return a ready snapshot, raise on WAV mismatch, else None to retry."""
    snapshot = _poll_real_epub_chapter_ready(
        driver, title, previous_revision, previous_audio_url,
        previous_audio_sha256, backend)
    if isinstance(snapshot, dict) and snapshot.get("__error"):
        message = snapshot["__error"]
        if "Real EPUB reader WAV mismatch" in message:
            raise RuntimeError(
                "Reader chapter readiness failed for " + title + ": " +
                message + "; nav=" +
                json.dumps(_safe_reader_nav_diagnostics(driver)))
        return None, message
    if (isinstance(snapshot, dict) and snapshot.get("title") == title and
            snapshot.get("nav")):
        return snapshot, None
    return None, None


def _wait_for_epub_chapter(driver, title, previous_revision=0, previous_audio_url=None,
                           previous_audio_sha256=None, backend="onnx"):
    # Drive the async storage+WAV poll from Python: Selenium's until() cannot
    # await browser.storage, and a falsy snapshot must retry.
    deadline = time.time() + 180
    last_error = None
    while time.time() < deadline:
        try:
            snapshot, poll_error = _epub_chapter_poll_result(
                driver, title, previous_revision, previous_audio_url,
                previous_audio_sha256, backend)
            if snapshot is not None:
                return snapshot
            if poll_error is not None:
                last_error = poll_error
        except RuntimeError:
            raise
        except Exception as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(
        "Reader chapter readiness failed for " + title + ": " +
        str(last_error or "timeout") + "; nav=" +
        json.dumps(_safe_reader_nav_diagnostics(driver)))


def _epub_button_nav_matches(nav, expected, expected_label):
    return (nav.get("prevDisabled") == expected["prevDisabled"] and
            nav.get("nextDisabled") == expected["nextDisabled"] and
            nav.get("activeLabel") == expected_label)


def _epub_nav_matches(snapshot, expected_label, previous_audio_url=None,
                      previous_audio_sha256=None, require_single_entry=False):
    expected = _expected_nav_for_title(snapshot.get("title"))
    nav = snapshot.get("nav")
    if expected is None or nav is None:
        return False
    if not _epub_button_nav_matches(nav, expected, expected_label):
        return False
    if previous_audio_url is not None and snapshot.get("audioUrl") == previous_audio_url:
        return False
    if (previous_audio_sha256 is not None and
            snapshot.get("audioSha256") == previous_audio_sha256):
        return False
    if snapshot.get("expectedSpeech") != READER_ACCEPTANCE_SPEECH.get(expected_label):
        return False
    if require_single_entry and len(nav.get("entries") or []) != 1:
        return False
    return True


def _epub_nav_failure_message(expected_label):
    if expected_label == "First Chapter":
        return "EPUB first chapter navigation controls incorrect: "
    if expected_label == "Second Chapter":
        return ("EPUB navigation failed to replace audio or update "
                "chapter controls: ")
    return "TXT document replacement retained stale EPUB audio or navigation: "


def _assert_epub_chapter_nav(driver, snapshot, expected_label, previous_audio_url=None,
                             previous_audio_sha256=None, require_single_entry=False):
    if _epub_nav_matches(
            snapshot, expected_label, previous_audio_url, previous_audio_sha256,
            require_single_entry):
        return
    detail = {
        "expected": _expected_nav_for_title(snapshot.get("title")),
        "snapshot": snapshot, "nav": snapshot.get("nav"),
        "previousAudioUrl": previous_audio_url,
        "previousAudioSha256": previous_audio_sha256,
        "live": _safe_reader_nav_diagnostics(driver),
    }
    raise RuntimeError(
        _epub_nav_failure_message(expected_label) + json.dumps(detail))


def _open_firefox_reader_for_backend(driver, origin, backend):
    config = reader_storage_config(backend)
    variant = epub_backend_variant(backend)
    configured = driver.execute_async_script("""
        const [stored, done] = arguments;
        browser.storage.sync.set(stored).then(
            () => done({ success: true }),
            e => done({ success: false, error: String(e) }));
    """, config)
    if not configured.get("success"):
        raise RuntimeError(
            "Cannot configure Firefox " + backend + " reader backend: " +
            str(configured))
    driver.get(origin + "/reader.html")
    WebDriverWait(driver, 30).until(lambda d: d.execute_script("""
        return Boolean(document.querySelector('#fileInput') &&
            document.querySelector('#playerFrame')?.contentDocument?.getElementById('status'));
    """))
    return variant


def _assert_reader_backend_unchanged(driver, backend):
    selected = driver.execute_async_script("""
        const done = arguments[arguments.length - 1];
        browser.storage.sync.get({ ttsBackend: 'fastapi' }).then(
            stored => done(stored.ttsBackend),
            e => done({ error: String(e) }));
    """)
    if selected != backend:
        raise RuntimeError(
            "Reader silently switched local TTS backend: expected " +
            backend + ", got " + str(selected))


def _return_to_benchmark_for_model_remove(driver, origin, backend):
    variant = epub_backend_variant(backend)
    selector = '[data-variant="' + variant + '"] .model-remove'
    driver.get(origin + "/benchmark.html")
    WebDriverWait(driver, 30).until(
        lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)") and
        d.find_element(By.CSS_SELECTOR, selector).is_enabled()
    )


def accept_real_epub_reader(driver, origin, backend):
    """Real Firefox file picker → EPUB.js → chapter nav → overlay → offline WAV."""
    require_epub_backend(backend)
    _open_firefox_reader_for_backend(driver, origin, backend)
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-epub-") as tmp:
        epub_path = Path(tmp) / "offline-reader-acceptance.epub"
        txt_path = Path(tmp) / "acceptance.txt"
        build_reader_acceptance_epub(epub_path)
        txt_path.write_text(
            READER_ACCEPTANCE_SPEECH["acceptance.txt"], encoding="utf-8")

        driver.find_element(By.ID, "fileInput").send_keys(str(epub_path))
        first = _wait_for_epub_chapter(
            driver, "First Chapter", backend=backend)
        _assert_epub_chapter_nav(driver, first, "First Chapter")

        driver.find_element(By.ID, "nextChapter").click()
        second = _wait_for_epub_chapter(
            driver, "Second Chapter", first["revision"], first["audioUrl"],
            first["audioSha256"], backend=backend)
        _assert_epub_chapter_nav(
            driver, second, "Second Chapter",
            previous_audio_url=first["audioUrl"],
            previous_audio_sha256=first["audioSha256"])

        driver.find_element(By.ID, "openAnotherDocument").click()
        driver.find_element(By.ID, "fileInput").send_keys(str(txt_path))
        plain_text = _wait_for_epub_chapter(
            driver, "acceptance.txt", second["revision"], second["audioUrl"],
            second["audioSha256"], backend=backend)
        _assert_epub_chapter_nav(
            driver, plain_text, "acceptance.txt",
            previous_audio_url=second["audioUrl"],
            previous_audio_sha256=second["audioSha256"],
            require_single_entry=True)

    _assert_reader_backend_unchanged(driver, backend)
    assert_distinct_chapter_audio_hashes(
        first["audioSha256"], second["audioSha256"], plain_text["audioSha256"])
    return {
        "success": True, "browser": "Firefox", "backend": backend,
        "epubFileSelectedThroughUi": True, "chapterCount": 2,
        "first": {"title": first["title"], "revision": first["revision"],
                  "audioBytes": first["bytes"],
                  "audioSha256": first["audioSha256"],
                  "speech": first["expectedSpeech"]},
        "second": {"title": second["title"], "revision": second["revision"],
                   "audioBytes": second["bytes"],
                   "audioSha256": second["audioSha256"],
                   "speech": second["expectedSpeech"]},
        "txtReplacement": {"title": plain_text["title"],
                           "revision": plain_text["revision"],
                           "audioBytes": plain_text["bytes"],
                           "audioSha256": plain_text["audioSha256"],
                           "speech": plain_text["expectedSpeech"]},
        "local24kHzWav": True, "differentAudioPerChapter": True,
        "offline": True, "noServerFallback": True, "autoplayDisabled": True,
        "userBackendUnchanged": True,
    }


def run_offline_epub_reader_acceptance(driver, origin, result, backend):
    """Opt-in EPUB/TXT reader stage for onnx or mediapipe; restores manager UI."""
    result["stage"] = "offline-real-epub-chapters-and-txt-reader"
    report = accept_real_epub_reader(driver, origin, backend)
    # Removal still uses the model-manager UI on benchmark.html.
    _return_to_benchmark_for_model_remove(driver, origin, backend)
    return report


def _set_firefox_network_offline(driver, offline):
    """Force Firefox offline/online via chrome-privileged Services.io."""
    driver.set_context("chrome")
    try:
        return driver.execute_script("""
            Services.io.manageOfflineStatus = false;
            Services.io.offline = arguments[0];
            return Services.io.offline;
        """, bool(offline))
    finally:
        driver.set_context("content")


def _start_article_selection_fixture_server(html):
    """Loopback HTTP fixture for Readability + floating-mic acceptance."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] in ("/", "/article.html"):
                body = html.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)

        def log_message(self, *args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}/article.html"


def _extension_async(driver, script, *args):
    """Run an async browser.* script while the driver is on an extension page."""
    return driver.execute_async_script(script, *args)


def _on_extension_page(driver, origin, script, *args):
    """Open benchmark.html briefly so browser.* APIs are available, then restore."""
    fixture_handle = driver.current_window_handle
    handles_before = set(driver.window_handles)
    driver.switch_to.new_window("tab")
    new_handles = set(driver.window_handles) - handles_before
    ext_handle = next(iter(new_handles))
    try:
        driver.get(origin + "/benchmark.html")
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)"))
        return _extension_async(driver, script, *args)
    finally:
        driver.close()
        driver.switch_to.window(fixture_handle)


# Firefox match patterns cannot include ports, so tabs.query({url: exactUrl})
# with http://127.0.0.1:PORT/... finds nothing. Resolve via host patterns.
_ARTICLE_FIND_FIXTURE_TAB_JS = """
async function findArticleFixtureTab(fixtureUrl) {
    const target = String(fixtureUrl || '').split('#')[0];
    const patterns = ['http://127.0.0.1/*', 'http://localhost/*'];
    let tabs = await browser.tabs.query({ url: patterns });
    let tab = tabs.find(entry => (entry.url || '').split('#')[0] === target);
    if (!tab) {
        tabs = await browser.tabs.query({});
        tab = tabs.find(entry => (entry.url || '').split('#')[0] === target);
    }
    if (!tab) {
        throw Error(
            'Fixture tab not found for ' + target + '; seen=' +
            JSON.stringify(tabs.map(entry => entry.url || null)));
    }
    return tab;
}
"""


def _seed_article_selection_storage(driver, origin, backend):
    storage = article_selection_storage_config(backend)
    seeded = _on_extension_page(driver, origin, """
        const [stored, done] = arguments;
        (async () => {
            await browser.storage.sync.set(stored);
            await browser.storage.local.remove([
                'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
                'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
            ]);
            done({ success: true });
        })().catch(e => done({ success: false, error: String(e) }));
    """, storage)
    if not seeded.get("success"):
        raise RuntimeError(
            "Cannot seed Firefox article/selection storage: " + str(seeded))


def _ensure_article_content_script(driver, origin, fixture_url):
    ensured = _on_extension_page(driver, origin, _ARTICLE_FIND_FIXTURE_TAB_JS + """
        const [fixtureUrl, done] = arguments;
        (async () => {
            const tab = await findArticleFixtureTab(fixtureUrl);
            const tabId = tab.id;
            try {
                await browser.tabs.sendMessage(tabId, { action: 'PING' });
            } catch {
                await browser.scripting.executeScript({
                    target: { tabId },
                    files: [
                        'browser-polyfill.min.js', 'readability.js',
                        'overlay-position.js', 'content.js',
                    ],
                });
                await new Promise(r => setTimeout(r, 150));
                await browser.tabs.sendMessage(tabId, { action: 'PING' });
            }
            await browser.tabs.update(tabId, { active: true });
            done({ success: true, tabId });
        })().catch(e => done({ success: false, error: String(e) }));
    """, fixture_url)
    if not ensured.get("success"):
        raise RuntimeError(
            "Cannot ensure Firefox content script on fixture: " + str(ensured))
    return ensured["tabId"]


# Overlay iframe WAV probe kept as one string so CodeFactor scores the
# Python poll loop, not the embedded Chromium-parity JS.
_ARTICLE_OVERLAY_WAV_SCRIPT = """
const [storedState, excludeSha, done] = arguments;
(async () => {
    const audio = document.getElementById('audio');
    const status = document.getElementById('status');
    const spinner = document.getElementById('loadingSpinner');
    const audioUrl = audio?.src;
    if (!audioUrl?.startsWith('blob:') ||
        spinner?.style.display !== 'none' ||
        status?.textContent === 'Error playing audio.' ||
        navigator.onLine !== false) {
        done(null);
        return;
    }
    let response;
    let bytes;
    try {
        response = await fetch(audioUrl);
        if (!response.ok) { done(null); return; }
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
        done(null);
        return;
    }
    if (audio.src !== audioUrl ||
        document.getElementById('loadingSpinner')?.style.display !== 'none') {
        done(null);
        return;
    }
    const tag = (offset, count) => String.fromCharCode(
        ...bytes.subarray(offset, offset + count));
    const header = bytes.byteLength >= 44
        ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : null;
    const audioBytes = header?.getUint32(40, true) ?? 0;
    if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
        header?.getUint32(24, true) !== 24000 ||
        audioBytes < 2 ||
        bytes.length !== 44 + audioBytes) {
        throw Error(
            'Firefox article/selection overlay WAV mismatch: ' +
            JSON.stringify({
                length: bytes.length, riff: tag(0, 4), wave: tag(8, 4),
                rate: header?.getUint32(24, true) ?? null, audioBytes,
            }));
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const audioSha256 = [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, '0')).join('');
    if (excludeSha && audioSha256 === excludeSha) {
        done(null);
        return;
    }
    done({
        audioBytes, audioSha256,
        backend: storedState.pendingTtsBackend,
        serverUrl: storedState.pendingApiUrl,
        pendingText: storedState.pendingText || '',
        blockCount: Array.isArray(storedState.pendingContent)
            ? storedState.pendingContent.length : 0,
        autoplay: storedState.pendingAutoplay === true,
        offline: navigator.onLine === false,
    });
})().catch(e => done({ error: String(e) }));
"""


def _article_pending_includes_speech(stored, expected_speech):
    blocks = stored.get("pendingContent")
    return isinstance(blocks, list) and any(
        isinstance(block, dict) and
        isinstance(block.get("content"), str) and
        expected_speech in block["content"]
        for block in blocks)


def _read_article_pending_storage(driver, origin):
    stored = _on_extension_page(driver, origin, """
        const done = arguments[arguments.length - 1];
        browser.storage.local.get([
            'pendingText', 'pendingContent', 'pendingTtsBackend',
            'pendingApiUrl', 'pendingAutoplay',
        ]).then(done, e => done({ error: String(e) }));
    """)
    if stored.get("error"):
        raise RuntimeError(stored["error"])
    return stored


def _read_article_overlay_frame_wav(driver, stored, exclude_audio_sha256):
    frames = driver.find_elements(
        By.CSS_SELECTOR, "#kokoro-overlay-container iframe")
    if not frames:
        return None
    driver.switch_to.frame(frames[0])
    try:
        snapshot = driver.execute_async_script(
            _ARTICLE_OVERLAY_WAV_SCRIPT, stored, exclude_audio_sha256)
    finally:
        driver.switch_to.default_content()
    if snapshot and snapshot.get("error"):
        raise RuntimeError(snapshot["error"])
    return snapshot


def _poll_article_overlay_once(driver, origin, expected_speech, mode,
                               exclude_audio_sha256):
    stored = _read_article_pending_storage(driver, origin)
    if not _article_pending_includes_speech(stored, expected_speech):
        return None
    host_mode = driver.execute_script("""
        return document.getElementById('kokoro-overlay-container')
            ?.dataset.mode || null;
    """)
    if mode and host_mode != mode:
        return None
    snapshot = _read_article_overlay_frame_wav(
        driver, stored, exclude_audio_sha256)
    if not snapshot:
        return None
    return {"speech": expected_speech, "mode": host_mode, **snapshot}


def _wait_article_overlay_wav(driver, origin, expected_speech, mode,
                              exclude_audio_sha256=None, timeout=180):
    """Poll extension storage + overlay iframe for a valid offline 24 kHz WAV."""
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            snapshot = _poll_article_overlay_once(
                driver, origin, expected_speech, mode, exclude_audio_sha256)
            if snapshot:
                return snapshot
        except Exception as exc:
            if "WAV mismatch" in str(exc):
                raise
            last_error = exc
        time.sleep(0.1)
    raise RuntimeError(
        "Timed out waiting for Firefox article/selection overlay WAV for " +
        expected_speech +
        ((": " + str(last_error)) if last_error else ""))


def _accept_firefox_floating_mic(driver, origin, fixture_url, backend, speech):
    driver.execute_script("""
        const el = document.getElementById('selection-sentence');
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    """)
    WebDriverWait(driver, 15).until(
        lambda d: d.find_element(By.ID, "kokoro-float-btn").is_displayed())
    driver.find_element(By.ID, "kokoro-float-btn").click()
    selection_snap = _wait_article_overlay_wav(
        driver, origin, speech["selection"], "popup")
    if (selection_snap.get("backend") != backend or
            (selection_snap.get("serverUrl") not in (None, ""))):
        raise RuntimeError(
            "Selection overlay left local backend: " + json.dumps(selection_snap))
    removed = _on_extension_page(driver, origin, _ARTICLE_FIND_FIXTURE_TAB_JS + """
        const [fixtureUrl, done] = arguments;
        (async () => {
            const tab = await findArticleFixtureTab(fixtureUrl);
            const tabId = tab.id;
            await browser.tabs.sendMessage(tabId, { action: 'REMOVE_PLAYER' })
                .catch(() => {});
            await browser.storage.local.remove([
                'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
                'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
            ]);
            await browser.tabs.update(tabId, { active: true });
            done({ success: true });
        })().catch(e => done({ success: false, error: String(e) }));
    """, fixture_url)
    if not removed.get("success"):
        raise RuntimeError(
            "Cannot clear Firefox selection player: " + str(removed))
    WebDriverWait(driver, 15).until(
        lambda d: d.execute_script(
            "return !document.getElementById('kokoro-overlay-container')"))
    return selection_snap


def _probe_firefox_parse_article(driver, origin, fixture_url, speech):
    probed = _on_extension_page(driver, origin, _ARTICLE_FIND_FIXTURE_TAB_JS + """
        const [fixtureUrl, done] = arguments;
        (async () => {
            const tab = await findArticleFixtureTab(fixtureUrl);
            const parsed = await browser.tabs.sendMessage(
                tab.id, { action: 'PARSE_ARTICLE' });
            if (!parsed?.text || !Array.isArray(parsed.content)) {
                throw Error('PARSE_ARTICLE failed: ' + JSON.stringify(parsed));
            }
            done({
                success: true,
                text: parsed.text,
                blockCount: parsed.content.length,
            });
        })().catch(e => done({ success: false, error: String(e) }));
    """, fixture_url)
    if not probed.get("success"):
        raise RuntimeError("Firefox PARSE_ARTICLE probe failed: " + str(probed))
    if (speech["articleFirst"] not in probed["text"] or
            speech["articleSecond"] not in probed["text"]):
        raise RuntimeError(
            "Article extract missed fixture paragraphs: " + json.dumps(probed))
    return probed


def _native_x11_python():
    """Prefer clean host Python for ctypes X11 — not the Selenium venv."""
    configured = (os.environ.get("KOKORO_NATIVE_PYTHON") or "").strip()
    if configured and Path(configured).is_file():
        return configured
    return sys.executable


def _send_native_read_article_alt_a():
    """Real X11 Alt+A — Selenium keys do not reach browser.commands.onCommand.

    Run native-firefox-keys.py in a **separate** process with
    KOKORO_NATIVE_PYTHON (fallback: sys.executable) + fixed argv. In-process
    ctypes X11 alongside Selenium/Firefox on the same DISPLAY aborted CI with
    munmap_chunk; Selenium-venv Python also aborted the child. Chromium uses
    the same env via Node execFileSync. Child focuses Firefox/Navigator then
    plays Alt+A.
    """
    helper = Path(__file__).resolve().parent / "native-firefox-keys.py"
    argv = [_native_x11_python(), str(helper), "Alt_L", "a"]
    try:
        completed = subprocess.run(
            argv, check=True, capture_output=True, text=True, timeout=15)
        native_alt_a = json.loads(completed.stdout.strip())
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        detail = ""
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            detail = ": " + exc.stderr.strip()[:400]
        raise RuntimeError(
            "Cannot send native Alt+A for Firefox read-article: " +
            str(exc) + detail)
    if (native_alt_a.get("x11XTest") is not True or
            native_alt_a.get("nativeKeys") != "Alt_L a"):
        raise RuntimeError(
            "Native X11 input did not confirm Alt+A: " + json.dumps(native_alt_a))
    return native_alt_a


def _prepare_firefox_read_article(driver, origin, fixture_url):
    WebDriverWait(driver, 15).until(
        lambda d: d.execute_script(
            "return !document.getElementById('kokoro-overlay-container')"))
    prepared = _on_extension_page(driver, origin, _ARTICLE_FIND_FIXTURE_TAB_JS + """
        const [fixtureUrl, done] = arguments;
        (async () => {
            const tab = await findArticleFixtureTab(fixtureUrl);
            const tabId = tab.id;
            let playerActive = false;
            try {
                const response = await browser.tabs.sendMessage(tabId, {
                    action: 'CHECK_PLAYER_ACTIVE',
                });
                playerActive = Boolean(response?.active);
            } catch {
                playerActive = false;
            }
            if (playerActive) {
                throw Error('Selection player still active before native Alt+A');
            }
            await browser.storage.local.remove([
                'pendingText', 'pendingContent', 'pendingVoice', 'pendingTitle',
                'pendingTtsBackend', 'pendingApiUrl', 'pendingAutoplay',
            ]);
            await browser.tabs.update(tabId, { active: true });
            const commands = await browser.commands.getAll();
            const bindings = commands.map(entry => ({
                name: entry.name, shortcut: entry.shortcut || '',
            }));
            const readArticle = bindings.find(entry => entry.name === 'read-article');
            done({
                success: true,
                bindings,
                shortcut: readArticle?.shortcut || '',
            });
        })().catch(e => done({ success: false, error: String(e) }));
    """, fixture_url)
    if not prepared.get("success"):
        raise RuntimeError(
            "Cannot prepare Firefox read-article: " + str(prepared))
    if not prepared.get("shortcut"):
        raise RuntimeError(
            "read-article command has no registered shortcut: " +
            json.dumps(prepared.get("bindings")))
    return prepared


def _wait_firefox_read_article_armed(driver, origin, backend, article_first):
    deadline = time.time() + 20
    while time.time() < deadline:
        armed = _on_extension_page(driver, origin, """
            const done = arguments[arguments.length - 1];
            browser.storage.local.get([
                'pendingText', 'pendingContent', 'pendingTtsBackend',
            ]).then(done, e => done({ error: String(e) }));
        """)
        if (isinstance(armed.get("pendingText"), str) and
                article_first in armed["pendingText"] and
                armed.get("pendingTtsBackend") == backend):
            return armed
        time.sleep(0.1)
    return None


def _assert_firefox_article_overlay_snap(article_snap, backend, speech):
    if (article_snap.get("backend") != backend or
            (article_snap.get("serverUrl") not in (None, ""))):
        raise RuntimeError(
            "Article overlay left local backend: " + json.dumps(article_snap))
    pending = article_snap.get("pendingText", "")
    if (speech["articleFirst"] not in pending or
            speech["articleSecond"] not in pending):
        raise RuntimeError(
            "read-article command did not store extracted article text: " +
            json.dumps({
                "pendingText": article_snap.get("pendingText"),
                "blockCount": article_snap.get("blockCount"),
            }))
    if article_snap.get("blockCount", 0) < 1:
        raise RuntimeError("read-article command stored empty pendingContent")


def _accept_firefox_read_article_command(
        driver, origin, fixture_url, backend, speech, exclude_audio_sha256=None):
    prepared = _prepare_firefox_read_article(driver, origin, fixture_url)
    driver.find_element(By.TAG_NAME, "body").click()
    time.sleep(0.3)
    native_alt_a = _send_native_read_article_alt_a()
    armed = _wait_firefox_read_article_armed(
        driver, origin, backend, speech["articleFirst"])
    if not armed:
        leftover = _on_extension_page(driver, origin, """
            const done = arguments[arguments.length - 1];
            browser.storage.local.get([
                'pendingText', 'pendingContent', 'pendingTtsBackend',
            ]).then(done, e => done({ error: String(e) }));
        """)
        raise RuntimeError(
            "Native Alt+A did not arm Firefox read-article storage: " +
            json.dumps({
                "nativeAltA": native_alt_a,
                "shortcut": prepared.get("shortcut"),
                "storageAfter": leftover,
            }))
    article_snap = _wait_article_overlay_wav(
        driver, origin, speech["articleFirst"], "full",
        exclude_audio_sha256=exclude_audio_sha256)
    _assert_firefox_article_overlay_snap(article_snap, backend, speech)
    return {
        "articleSnap": article_snap,
        "shortcut": prepared["shortcut"],
        "nativeAltA": native_alt_a,
    }


def accept_real_article_and_selection(driver, origin, backend):
    """Real webpage selection + Alt+A read-article against a loopback fixture."""
    require_article_selection_backend(backend)
    fixture = load_article_selection_fixture()
    html = fixture["html"]
    speech = fixture["speech"]
    server, fixture_url = _start_article_selection_fixture_server(html)
    try:
        _seed_article_selection_storage(driver, origin, backend)
        # Services.io.offline blocks loopback; briefly go online for page.goto.
        _set_firefox_network_offline(driver, False)
        driver.get(fixture_url)
        WebDriverWait(driver, 30).until(
            lambda d: d.execute_script(
                "return Boolean(document.getElementById('selection-sentence') && "
                "document.getElementById('article-first'))"))
        _ensure_article_content_script(driver, origin, fixture_url)
        offline = _set_firefox_network_offline(driver, True)
        if not offline or driver.execute_script("return navigator.onLine !== false"):
            raise RuntimeError(
                "Firefox did not re-enter offline mode before article/selection TTS")

        selection_snap = _accept_firefox_floating_mic(
            driver, origin, fixture_url, backend, speech)
        article_extract = _probe_firefox_parse_article(
            driver, origin, fixture_url, speech)
        article_path = _accept_firefox_read_article_command(
            driver, origin, fixture_url, backend, speech,
            exclude_audio_sha256=selection_snap.get("audioSha256"))
        article_snap = article_path["articleSnap"]
        assert_distinct_article_selection_audio_hashes(
            selection_snap["audioSha256"], article_snap["audioSha256"])

        _on_extension_page(driver, origin, _ARTICLE_FIND_FIXTURE_TAB_JS + """
            const [fixtureUrl, done] = arguments;
            (async () => {
                try {
                    const tab = await findArticleFixtureTab(fixtureUrl);
                    await browser.tabs.sendMessage(
                        tab.id, { action: 'REMOVE_PLAYER' }).catch(() => {});
                } catch {
                    /* fixture may already be gone during teardown */
                }
                done({ success: true });
            })().catch(e => done({ success: false, error: String(e) }));
        """, fixture_url)

        return {
            "success": True,
            "browser": "Firefox",
            "backend": backend,
            "fixtureUrl": fixture_url,
            "selection": {
                "path": "floating-mic",
                "mode": selection_snap.get("mode"),
                "speech": speech["selection"],
                "audioBytes": selection_snap.get("audioBytes"),
                "audioSha256": selection_snap.get("audioSha256"),
            },
            "article": {
                "path": "read-article-command-native-x11",
                "shortcut": article_path["shortcut"],
                "nativeKeys": article_path["nativeAltA"].get("nativeKeys"),
                "mode": article_snap.get("mode"),
                "speech": speech["articleFirst"],
                "extractedTextIncludesBothParagraphs": True,
                "parseArticleProbeBlockCount": article_extract["blockCount"],
                "blockCount": article_snap.get("blockCount"),
                "audioBytes": article_snap.get("audioBytes"),
                "audioSha256": article_snap.get("audioSha256"),
            },
            "local24kHzWav": True,
            "differentAudioPerPath": True,
            "offline": True,
            "noServerFallback": True,
            "userBackendUnchanged": True,
        }
    finally:
        # Best-effort fixture teardown; do not mask the acceptance error.
        with contextlib.suppress(OSError, RuntimeError):
            server.shutdown()
        with contextlib.suppress(OSError, RuntimeError):
            server.server_close()


def run_offline_article_selection_acceptance(driver, origin, result, backend):
    """Opt-in article/selection stage for Firefox ONNX origin; restores manager UI."""
    result["stage"] = "offline-real-article-and-selection"
    report = accept_real_article_and_selection(driver, origin, backend)
    _return_to_benchmark_for_model_remove(driver, origin, backend)
    return report


def _wait_firefox_long_form_overlay_ready(driver, index, timeout_s=180):
    WebDriverWait(driver, timeout_s).until(lambda d: d.execute_script("""
        const [idx, count] = arguments;
        const spans = document.querySelectorAll('.sentence');
        return spans.length >= count &&
            spans[idx]?.classList.contains('highlight') &&
            document.getElementById('audio')?.src.startsWith('blob:') &&
            document.getElementById('loadingSpinner')?.style.display === 'none' &&
            typeof window.__kokoroAudioManagerStats === 'function';
    """, index, LONG_FORM_SENTENCE_COUNT))


def _read_firefox_long_form_stats(driver):
    return driver.execute_script("return window.__kokoroAudioManagerStats();")


def _read_firefox_long_form_heap(driver):
    return driver.execute_script("""
        const mem = performance.memory;
        return mem && Number.isFinite(mem.usedJSHeapSize)
            ? mem.usedJSHeapSize : null;
    """)


def _read_firefox_long_form_wav_meta(driver):
    meta = driver.execute_async_script("""
        const done = arguments[arguments.length - 1];
        (async () => {
            const audio = document.getElementById('audio');
            const bytes = new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
            const wav = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const tag = (start, length) =>
                String.fromCharCode(...bytes.subarray(start, start + length));
            const audioBytes = wav.getUint32(40, true);
            if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE' ||
                wav.getUint32(24, true) !== 24000 || audioBytes < 2 ||
                bytes.length !== 44 + audioBytes) {
                throw Error('Long-form overlay WAV mismatch');
            }
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const audioSha256 = [...new Uint8Array(digest)]
                .map(b => b.toString(16).padStart(2, '0')).join('');
            done({
                audioBytes, audioSha256, paused: audio.paused,
                offline: navigator.onLine === false,
            });
        })().catch(e => done({ error: String(e) }));
    """)
    if meta.get("error"):
        raise RuntimeError("Firefox long-form WAV read failed: " + str(meta))
    return meta


def _seed_firefox_long_form_overlay(driver, origin, storage):
    seeded = _on_extension_page(driver, origin, """
        const [cfg, done] = arguments;
        browser.storage.local.set(cfg).then(
            () => done({ success: true }),
            e => done({ success: false, error: String(e) }));
    """, storage)
    if not seeded.get("success"):
        raise RuntimeError(
            "Cannot seed Firefox long-form overlay: " + str(seeded))
    driver.get(origin + "/overlay.html")
    _wait_firefox_long_form_overlay_ready(
        driver, 0, timeout_s=240)


def _walk_firefox_long_form_sentences(driver, visit_indexes):
    max_cache = 0
    max_urls = 0
    samples = []
    for index in visit_indexes:
        if index > 0:
            driver.execute_script("""
                document.querySelectorAll('.sentence')[arguments[0]].click();
            """, index)
            _wait_firefox_long_form_overlay_ready(driver, index)
        time.sleep(0.25)
        stats = _read_firefox_long_form_stats(driver)
        assert_bounded_audio_manager_stats(stats)
        max_cache = max(max_cache, stats["cacheSize"])
        max_urls = max(max_urls, stats["objectUrlCount"])
        if index in (0, visit_indexes[-1]):
            samples.append({
                "index": index,
                **_read_firefox_long_form_wav_meta(driver),
                **stats,
            })
    return {
        "maxCacheSize": max_cache,
        "maxObjectUrlCount": max_urls,
        "samples": samples,
    }


def _jump_firefox_long_form_across_windows(driver, bounds):
    last_index = LONG_FORM_SENTENCE_COUNT - 1
    driver.execute_script(
        "document.querySelectorAll('.sentence')[0].click();")
    _wait_firefox_long_form_overlay_ready(driver, 0)
    time.sleep(0.25)
    at_zero = _read_firefox_long_form_stats(driver)
    assert_bounded_audio_manager_stats(at_zero)
    assert_long_form_cache_window_near(at_zero, 0)
    zero_wav = _read_firefox_long_form_wav_meta(driver)

    driver.execute_script(
        "document.querySelectorAll('.sentence')[arguments[0]].click();",
        last_index)
    _wait_firefox_long_form_overlay_ready(driver, last_index)
    time.sleep(0.25)
    jump = _read_firefox_long_form_stats(driver)
    assert_bounded_audio_manager_stats(jump)
    assert_long_form_cache_window_near(jump, last_index)
    final_wav = _read_firefox_long_form_wav_meta(driver)
    if final_wav["audioSha256"] == zero_wav["audioSha256"]:
        raise RuntimeError(
            "Distant jump WAV hash matched index-0 hash: " +
            json.dumps({"zero": zero_wav["audioSha256"],
                        "last": final_wav["audioSha256"]}))
    if (jump["window"]["first"] == at_zero["window"]["first"] and
            jump["window"]["last"] == at_zero["window"]["last"]):
        raise RuntimeError(
            "Distant jump did not move cache window: " +
            json.dumps({"atZero": at_zero["window"], "jump": jump["window"]}))
    return {
        "maxCacheSize": max(
            bounds["maxCacheSize"], at_zero["cacheSize"], jump["cacheSize"]),
        "maxObjectUrlCount": max(
            bounds["maxObjectUrlCount"], at_zero["objectUrlCount"],
            jump["objectUrlCount"]),
        "jumpCacheSize": jump["cacheSize"],
        "returnToZeroCacheSize": at_zero["cacheSize"],
        "windowAfterReturn": at_zero["window"],
        "windowAfterJump": jump["window"],
        "zeroAudioSha256": zero_wav["audioSha256"],
        "jumpAudioSha256": final_wav["audioSha256"],
        "finalWav": final_wav,
        "samples": [
            {"index": 0, "phase": "return-before-jump",
             **zero_wav, **at_zero},
            {"index": last_index, "phase": "distant-jump",
             **final_wav, **jump},
        ],
    }


def _read_firefox_sync_tts_backend(driver, origin):
    return _on_extension_page(driver, origin, """
        const done = arguments[arguments.length - 1];
        browser.storage.sync.get({ ttsBackend: 'fastapi' }).then(
            data => done({ success: true, ttsBackend: data.ttsBackend }),
            e => done({ success: false, error: String(e) }));
    """)


def accept_firefox_long_form_memory(driver, origin, backend):
    """Walk many overlay sentences; probe proves cache/URL window stays bounded."""
    require_long_form_backend(backend)
    fixture = load_long_form_fixture(backend)
    sync_before = _read_firefox_sync_tts_backend(driver, origin)
    if not sync_before.get("success"):
        raise RuntimeError(
            "Cannot read sync ttsBackend before long-form: " + str(sync_before))
    sync_before_backend = sync_before["ttsBackend"]

    _seed_firefox_long_form_overlay(driver, origin, fixture["storage"])
    heap_before = _read_firefox_long_form_heap(driver)
    walk = _walk_firefox_long_form_sentences(driver, fixture["visits"])
    jump = _jump_firefox_long_form_across_windows(driver, walk)
    walk["samples"].extend(jump["samples"])

    heap_after = _read_firefox_long_form_heap(driver)
    heap = None
    if heap_before is not None and heap_after is not None:
        heap = assert_long_form_heap_delta(heap_before, heap_after)

    privacy = driver.execute_async_script("""
        const done = arguments[arguments.length - 1];
        browser.storage.local.get([
            'pendingTtsBackend', 'pendingApiUrl', 'apiUrl',
        ]).then(done, e => done({ error: String(e) }));
    """)
    if privacy.get("error"):
        raise RuntimeError(
            "Cannot read long-form privacy storage: " + str(privacy))
    if privacy.get("pendingTtsBackend") != backend:
        raise RuntimeError(
            "pendingTtsBackend drifted from seeded onnx session: " +
            json.dumps(privacy))
    if privacy.get("pendingApiUrl") or privacy.get("apiUrl"):
        raise RuntimeError(
            "Long-form acceptance saw a server URL: " + json.dumps(privacy))
    if jump["finalWav"].get("offline") is not True:
        raise RuntimeError("Long-form overlay was not offline at end")

    # Overlay page may not expose sync; read via extension page after walk.
    sync_after = _read_firefox_sync_tts_backend(driver, origin)
    if not sync_after.get("success"):
        raise RuntimeError(
            "Cannot read sync ttsBackend after long-form: " + str(sync_after))
    if sync_after["ttsBackend"] != sync_before_backend:
        raise RuntimeError(
            "chrome.storage.sync ttsBackend changed during long-form: " +
            json.dumps({"syncBefore": sync_before_backend,
                        "syncAfter": sync_after["ttsBackend"]}))

    return {
        "success": True,
        "browser": "Firefox",
        "backend": backend,
        "sentenceCount": LONG_FORM_SENTENCE_COUNT,
        "visitedCount": len(fixture["visits"]),
        "maxCacheSize": jump["maxCacheSize"],
        "maxObjectUrlCount": jump["maxObjectUrlCount"],
        "jumpCacheSize": jump["jumpCacheSize"],
        "returnToZeroCacheSize": jump["returnToZeroCacheSize"],
        "windowAfterReturn": jump["windowAfterReturn"],
        "windowAfterJump": jump["windowAfterJump"],
        "zeroAudioSha256": jump["zeroAudioSha256"],
        "jumpAudioSha256": jump["jumpAudioSha256"],
        "distantJumpChangedWindow": True,
        "local24kHzWav": True,
        "offline": True,
        "noServerFallback": True,
        "acceptanceProbe": True,
        "heap": heap,
        "samples": walk["samples"],
        "syncTtsBackend": sync_after["ttsBackend"],
        "userBackendUnchanged":
            sync_after["ttsBackend"] == sync_before_backend,
    }


def run_offline_long_form_memory_acceptance(driver, origin, result, backend):
    """Opt-in long-form memory stage for Firefox onnx/mediapipe origin; restores manager UI."""
    result["stage"] = "offline-real-long-form-memory"
    report = accept_firefox_long_form_memory(driver, origin, backend)
    _return_to_benchmark_for_model_remove(driver, origin, backend)
    return report


def main():
    if os.environ.get("KOKORO_LIVE_DOWNLOAD") != "1":
        raise RuntimeError("Explicit model download opt-in is required")
    if os.environ.get("KOKORO_FIREFOX_QUOTA_ACCEPTANCE") == "1":
        run_firefox_quota_acceptance()
        return
    if os.environ.get("KOKORO_FIREFOX_PERSISTENT_RESTART") == "1":
        run_permanent_addon_restart_acceptance()
        return
    provider = os.environ.get("KOKORO_FIREFOX_PROVIDER", "onnx")
    origin_download = os.environ.get("KOKORO_FIREFOX_ORIGIN_DOWNLOAD") == "1"
    dual_comparison = os.environ.get("KOKORO_FIREFOX_DUAL_COMPARISON") == "1"
    if origin_download and provider not in ("mediapipe", "onnx"):
        raise ValueError("Official-origin Firefox acceptance requires MediaPipe CPU or ONNX q8")
    if provider not in ("onnx", "mediapipe", "dictionary", "both"):
        raise ValueError("KOKORO_FIREFOX_PROVIDER must be onnx, mediapipe, dictionary, or both")
    if dual_comparison != (provider == "both") or (dual_comparison and origin_download):
        raise ValueError("Firefox both-provider comparison requires explicit dual opt-in and verified local preload")
    output = Path("dist/runtime-acceptance/firefox.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"status": "started", "browser": "Firefox MV3",
              "originDownload": origin_download, "provider": provider}
    driver = None
    server = None
    with tempfile.TemporaryDirectory(prefix="kokoro-firefox-") as tmp:
        root = Path(tmp)
        try:
            manifests = pinned_manifest(provider)
            files = {}
            if not origin_download:
                for manifest in manifests:
                    files.update(verified_assets(manifest, root))
            state = {"origin": None}
            if not origin_download:
                token = secrets.token_hex(32)
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
            # Headed under Xvfb so native X11 Alt+A reaches browser.commands
            # (article/selection). Keep -headless only when no DISPLAY is set.
            if not os.environ.get("DISPLAY"):
                options.add_argument("-headless")
            options.set_preference("xpinstall.signatures.required", False)
            options.set_preference("extensions.experiments.enabled", True)
            # Without this, Alt focuses the menu bar and steals Alt+A before
            # browser.commands.onCommand (XTest reports success, storage stays empty).
            options.set_preference("ui.key.menuAccessKeyFocuses", False)
            options.set_preference("ui.key.menuAccessKey", 0)
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
            dictionary_ui_acceptance = None
            origin_model_acceptance = None
            preflight = driver.execute_async_script("""
                const done=arguments[arguments.length-1];
                window.KokoroBenchmark.inspectCapabilities().then(done, e=>done({error:String(e)}));
            """)
            if not preflight.get("wasmCompilation"):
                raise RuntimeError("Firefox MV3 extension-page WASM compilation unavailable: " + str(preflight))

            # Check real pinned dictionary CORS/SRI download in the packaged
            # extension itself. Weight preload is loopback only in legacy mode.
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
                // Marionette executes each call in a new sandbox. Store the
                // hook on the real page window, not sandbox globalThis.
                const page=window.wrappedJSObject||window;
                const original=page.fetch;
                page.__modelManagerOriginalFetch=original;
                page.__modelManagerAssetFetches=0;
                const guarded=(...args)=>{
                    const url=String(args[0]?.url||args[0]);
                    if(url.startsWith('https://huggingface.co/')||
                        url.startsWith('https://raw.githubusercontent.com/')){
                        page.__modelManagerAssetFetches++;
                        throw Error('Unexpected model fetch by manager UI');
                    }
                    return original.apply(page,args);
                };
                if(typeof exportFunction==='function'){
                    exportFunction(guarded,page,{defineAs:'fetch'});
                }else{
                    page.fetch=guarded;
                }
                if(typeof page.fetch!=='function')
                    throw Error('Could not install page-window fetch guard');
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
                    const page=window.wrappedJSObject||window;
                    return {...(await store.status(dictionaryManifest())),
                        pageModelFetches:page.__modelManagerAssetFetches};
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
            # Restore the original fetch before exercising the real packaged
            # ONNX/MediaPipe runtime in this same temporary Firefox page.
            driver.execute_script("""
                const page=window.wrappedJSObject||window;
                if(typeof page.__modelManagerOriginalFetch!=='function')
                    throw Error('Missing original Firefox page fetch');
                page.fetch=page.__modelManagerOriginalFetch;
                delete page.__modelManagerOriginalFetch;
            """)
            # Validate Download/Cancel/Retry through the real packaged
            # Firefox UI, not a direct ModelDataStore.install() call.
            try:
                dictionary_ui_acceptance = run_dictionary_ui_acceptance(driver)
            except Exception as exc:
                dictionary_ui_acceptance = {"success": False, "error": str(exc)}
                raise
            if provider == "dictionary":
                result = {
                    "status": "passed",
                    "browser": driver.capabilities.get("browserVersion"),
                    "extensionId": addon_id,
                    "preflight": preflight,
                    "provider": "dictionary",
                    "dictionaryCacheAcceptance": dictionary_cache_acceptance,
                    "dictionaryReloadAcceptance": dictionary_reload_acceptance,
                    "dictionaryUiDownloadAcceptance": dictionary_ui_acceptance,
                    "offlineAttempted": False, "offlineInference": False,
                    "scope": "Firefox temporary MV3 addon dictionary-only UI and "
                             "integrity acceptance; no model-backed inference",
                }
                print("FIREFOX DICTIONARY UI ACCEPTANCE", json.dumps(result), flush=True)
                return
            # The explicit origin path clicks the actual model-manager
            # Download button rather than transferring verified runner bytes.
            if origin_download:
                if provider == "onnx":
                    # The dictionary UI regression deliberately removed its
                    # model data; request it again from the user's control.
                    dictionary_reinstalled = restore_onnx_dictionary_from_real_ui(driver)
                origin_model_acceptance = run_model_origin_ui_acceptance(
                    driver, manifests[0])
                if provider == "onnx":
                    origin_model_acceptance["dictionaryReinstalledThroughUi"] = (
                        dictionary_reinstalled)
            else:
                # Existing loopback bootstrap is retained only for the
                # non-origin model inference acceptance mode.
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
            if dual_comparison:
                result["stage"] = "offline-two-provider-same-page-benchmark"
                comparison = accept_two_backend_comparison(driver, state["origin"])
                result.update({
                    "status": "passed",
                    "browser": driver.capabilities.get("browserVersion"),
                    "extensionId": addon_id,
                    "preflight": preflight,
                    "dictionaryCacheAcceptance": dictionary_cache_acceptance,
                    "dictionaryReloadAcceptance": dictionary_reload_acceptance,
                    "dictionaryUiDownloadAcceptance": dictionary_ui_acceptance,
                    "dualComparisonAcceptance": comparison,
                    "offlineAttempted": True,
                    "offlineInference": True,
                    "cachePopulation": "two models and dictionary SHA-256 verified from pinned official sources; authenticated loopback preload, offline same-page synthesis",
                    "scope": "Firefox/Linux MV3 sequential dual local backend comparison, no subjective quality or EPUB acceptance",
                })
                print("FIREFOX DUAL BENCHMARK ACCEPTANCE", json.dumps(result), flush=True)
                return
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

            # ONNX has passed the isolated engine check. Exercise the *actual*
            # AudioManager route as a separate opt-in, offline browser gate:
            # ordinary English -> serialized ONNX q8 -> locally generated WAV.
            # Unsupported English must fail closed rather than contact FastAPI.
            playback_acceptance = None
            if origin_download and provider == "onnx" and metrics.get("success"):
                playback_acceptance = driver.execute_async_script("""
                    const done=arguments[arguments.length-1];
                    (async()=>{
                        const {AudioManager}=await import('./audio-manager.js');
                        const page=window.wrappedJSObject||window;
                        const counters=()=>{
                            if(typeof page.__originModelStatsJson!=='function')
                                throw Error('Missing official-origin fetch counters');
                            return JSON.parse(page.__originModelStatsJson()).requests.length;
                        };
                        const requestsBefore=counters();
                        const manager=new AudioManager();
                        try{
                            await browser.storage.local.set({pendingTtsBackend:'onnx',pendingApiUrl:''});
                            manager.setSentences([
                                {text:'Hello world.'},
                                {text:'zzzzqwertyword.'},
                            ]);
                            const url=await manager.getAudio(0);
                            if(!url.startsWith('blob:'))throw Error('ONNX did not create a local WAV Blob');
                            const response=await fetch(url);
                            if(!response.ok)throw Error('Unable to read local WAV Blob');
                            const bytes=new Uint8Array(await response.arrayBuffer());
                            if(bytes.length<46)throw Error('WAV audio was empty');
                            const h=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
                            const tag=(offset,length)=>String.fromCharCode(
                                ...bytes.subarray(offset,offset+length));
                            const sampleRateHz=h.getUint32(24,true);
                            const audioBytes=h.getUint32(40,true);
                            if(tag(0,4)!=='RIFF'||tag(8,4)!=='WAVE'||
                                sampleRateHz!==24000||audioBytes<2||
                                bytes.length!==44+audioBytes)
                                throw Error('Invalid generated ONNX WAV header/data');
                            let unsupported=null;
                            try{await manager.getAudio(1)}catch(e){unsupported=String(e)}
                            if(!unsupported||!/Missing English pronunciation|Unsupported English text/.test(unsupported))
                                throw Error('ONNX unknown word did not fail closed: '+unsupported);
                            const requestsAfter=counters();
                            if(requestsAfter!==requestsBefore)
                                throw Error('ONNX playback unexpectedly fetched model data');
                            return {
                                success:true,engine:'onnx',backend:'onnx',
                                sampleRateHz,audioBytes,
                                unknownWordsRejected:true,remoteFallback:false,
                                modelFetchesDuringPlayback:requestsAfter-requestsBefore,
                                networkOffline:navigator.onLine===false,
                            };
                        }finally{
                            manager.clear();
                            if(manager.localProvider)await manager.localProvider.close();
                        }
                    })().then(done,e=>done({success:false,error:String(e),stack:String(e.stack||'')}));
                """)
                if (not playback_acceptance.get("success") or
                        not playback_acceptance.get("networkOffline") or
                        playback_acceptance.get("modelFetchesDuringPlayback") != 0 or
                        not playback_acceptance.get("unknownWordsRejected")):
                    raise RuntimeError("Firefox ONNX AudioManager offline playback acceptance failed: " +
                                       str(playback_acceptance))

            # Real extension overlay UI acceptance, not a direct provider call.
            # Three separate blocks prevent accidental sentence merging;
            # the last unsupported English sentence must expose real Retry.
            # Autoplay is disabled for deterministic headless controls.
            overlay_acceptance = None
            if origin_download and provider == "onnx" and metrics.get("success"):
                saved = driver.execute_async_script("""
                    const done=arguments[arguments.length-1];
                    browser.storage.local.set({
                        pendingTtsBackend:'onnx',pendingApiUrl:null,
                        pendingText:'Hello world. Hello world. zzzzqwertyword.',
                        pendingContent:[
                            {type:'text',content:'Hello world.'},
                            {type:'text',content:'Hello world.'},
                            {type:'text',content:'zzzzqwertyword.'}
                        ],
                        pendingTitle:'ONNX overlay acceptance',
                        pendingAutoplay:false
                    }).then(()=>done({success:true}),e=>done({success:false,error:String(e)}));
                """)
                if not saved.get("success"):
                    raise RuntimeError("Cannot seed Firefox ONNX overlay: " + str(saved))
                driver.get(state["origin"] + "/overlay.html")
                def overlay_ready(index):
                    return driver.execute_script("""
                        const spans=document.querySelectorAll('.sentence');
                        const audio=document.getElementById('audio');
                        return spans.length===3 &&
                            spans[arguments[0]]?.classList.contains('highlight') &&
                            audio?.src.startsWith('blob:') &&
                            document.getElementById('loadingSpinner')?.style.display==='none';
                    """, index)
                WebDriverWait(driver, 180).until(lambda d: overlay_ready(0))
                first_wav = driver.execute_async_script("""
                    const done=arguments[arguments.length-1];
                    (async()=>{
                        const audio=document.getElementById('audio');
                        const bytes=new Uint8Array(await (await fetch(audio.src)).arrayBuffer());
                        const h=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
                        const tag=(offset,length)=>String.fromCharCode(
                            ...bytes.subarray(offset,offset+length));
                        const audioBytes=h.getUint32(40,true);
                        if(tag(0,4)!=='RIFF'||tag(8,4)!=='WAVE'||
                            h.getUint32(24,true)!==24000||audioBytes<2||
                            bytes.length!==44+audioBytes)
                            throw Error('Firefox overlay returned malformed ONNX WAV');
                        if(!audio.paused||document.getElementById('playPause').textContent!=='Play')
                            throw Error('Autoplay-disabled Firefox overlay unexpectedly started playing');
                        if(navigator.onLine!==false)throw Error('Firefox overlay not offline');
                        return {success:true,firstUrl:audio.src,sampleRateHz:24000,
                            audioBytes,initiallyPaused:true};
                    })().then(done,e=>done({success:false,error:String(e)}));
                """)
                if not first_wav.get("success"):
                    raise RuntimeError("Firefox ONNX overlay WAV invalid: " + str(first_wav))
                driver.find_element(By.ID, "seekFwd").click()
                WebDriverWait(driver, 180).until(lambda d: overlay_ready(1))
                driver.find_element(By.ID, "seekBack").click()
                WebDriverWait(driver, 180).until(lambda d: overlay_ready(0))
                settings = driver.execute_script("""
                    const speed=document.getElementById('speed');
                    speed.value='1.25';
                    speed.dispatchEvent(new Event('change',{bubbles:true}));
                    const volume=document.getElementById('volumeControl');
                    volume.value='0.4';
                    volume.dispatchEvent(new Event('input',{bubbles:true}));
                    const audio=document.getElementById('audio');
                    return {rate:audio.playbackRate,volume:audio.volume,paused:audio.paused};
                """)
                if (abs(settings["rate"] - 1.25) > 0.001 or
                        abs(settings["volume"] - 0.4) > 0.001 or
                        not settings["paused"]):
                    raise RuntimeError("Firefox ONNX overlay controls failed: " + str(settings))
                # Trigger a real unsupported-word playback error before Retry.
                # A healthy player intentionally keeps Retry hidden.
                driver.find_element(By.ID, "seekFwd").click()
                WebDriverWait(driver, 180).until(lambda d: overlay_ready(1))
                driver.find_element(By.ID, "seekFwd").click()
                WebDriverWait(driver, 180).until(lambda d: d.execute_script("""
                    const retry=document.getElementById('retry');
                    const spans=document.querySelectorAll('.sentence');
                    return spans.length===3&&spans[2].classList.contains('highlight')&&
                        document.getElementById('status')?.textContent==='Error playing audio.'&&
                        getComputedStyle(retry).display!=='none'&&
                        document.getElementById('loadingSpinner')?.style.display==='none';
                """))
                repaired = driver.execute_async_script("""
                    const done=arguments[arguments.length-1];
                    browser.storage.local.set({
                        pendingText:'Hello world. Hello world. Hello world.',
                        pendingContent:[
                            {type:'text',content:'Hello world.'},
                            {type:'text',content:'Hello world.'},
                            {type:'text',content:'Hello world.'}
                        ]
                    }).then(()=>done({success:true}),e=>done({success:false,error:String(e)}));
                """)
                if not repaired.get("success"):
                    raise RuntimeError("Cannot repair Firefox overlay input: " + str(repaired))
                driver.find_element(By.ID, "retry").click()
                WebDriverWait(driver, 180).until(lambda d: d.execute_script("""
                    const spans=document.querySelectorAll('.sentence');
                    const audio=document.getElementById('audio');
                    return spans.length===3&&spans[0].classList.contains('highlight')&&
                        audio?.src.startsWith('blob:')&&audio.src!==arguments[0]&&
                        getComputedStyle(document.getElementById('retry')).display==='none'&&
                        document.getElementById('loadingSpinner')?.style.display==='none';
                """, first_wav["firstUrl"]))
                overlay_acceptance = {
                    "success": True, "sentences": 3, "initiallyPaused": True,
                    "unsupportedSentenceRejected": True, "retryRestoredAudio": True,
                    "sampleRateHz": first_wav["sampleRateHz"],
                    "audioBytes": first_wav["audioBytes"],
                    "controls": ["next", "previous", "speed", "volume", "retry-after-error"],
                    "rate": settings["rate"], "volume": settings["volume"],
                    "networkOffline": True,
                }
                # Remove must still be driven by the existing manager UI.
                driver.get(state["origin"] + "/benchmark.html")
                WebDriverWait(driver, 30).until(
                    lambda d: d.execute_script("return Boolean(window.KokoroBenchmark)") and
                    d.find_element(By.CSS_SELECTOR, '[data-variant="onnx-q8"] .model-remove').is_enabled()
                )

            benchmark_acceptance = None
            if origin_download and metrics.get("success"):
                # Exercise the actual benchmark comparison UI with cached
                # official-origin model bytes and no network access.
                benchmark_acceptance = accept_local_benchmark_ui(
                    driver, state["origin"], provider)

            # Real packaged reader: file picker → EPUB.js chapters → overlay WAV,
            # then TXT replacement. Must run while the origin model is still
            # cached and before Remove. Mirrors Chromium onnx/mediapipe stages.
            epub_reader_acceptance = None
            if origin_epub_stage_enabled(
                    origin_download, provider, metrics.get("success")):
                epub_reader_acceptance = run_offline_epub_reader_acceptance(
                    driver, state["origin"], result, provider)

            # Real webpage floating-mic selection + native Alt+A read-article.
            article_selection_acceptance = None
            if origin_article_selection_stage_enabled(
                    origin_download, provider, metrics.get("success")):
                article_selection_acceptance = (
                    run_offline_article_selection_acceptance(
                        driver, state["origin"], result, provider))

            # Real overlay long-form memory bounds (onnx/mediapipe origin).
            long_form_memory_acceptance = None
            if origin_long_form_memory_stage_enabled(
                    origin_download, provider, metrics.get("success")):
                long_form_memory_acceptance = (
                    run_offline_long_form_memory_acceptance(
                        driver, state["origin"], result, provider))

            if origin_download and metrics.get("success"):
                # Close the active engine before Remove; no re-download may
                # occur and other-provider assets must not be modified.
                model_variant = "q8" if provider == "onnx" else "cpu"
                model_row = f'[data-variant="{provider}-{model_variant}"]'
                driver.find_element(
                    By.CSS_SELECTOR, model_row + " .model-remove").click()
                WebDriverWait(driver, 30).until(
                    lambda d: "Not installed" in d.find_element(
                        By.CSS_SELECTOR, model_row + " .model-status").text
                    and not d.find_element(
                        By.CSS_SELECTOR, model_row + " .model-remove").is_enabled()
                    and d.find_element(
                        By.CSS_SELECTOR, model_row + " .model-download").is_enabled()
                )
                removal = driver.execute_async_script("""
                    const [provider,variant,done]=arguments;
                    (async()=>{
                        if(navigator.onLine!==false)
                            throw Error('Firefox unexpectedly online during removal');
                        const [{ModelDataStore},{manifestForVariant,dictionaryManifest}]=
                            await Promise.all([
                                import('./model-data-store.js'),
                                import('./model-catalog.js')]);
                        const store=new ModelDataStore({
                            origin:browser.runtime.getURL('/'),cacheStorage:caches,
                            fetchImpl:()=>{throw Error('Removal must not fetch model data')},
                            responseClass:Response,streamClass:TransformStream});
                        const model=await store.status(manifestForVariant(provider,variant));
                        const otherProvider=provider==='onnx'?'mediapipe':'onnx';
                        const variants=provider==='onnx'?['cpu','gpu']:['q8','q8f16'];
                        const otherStatus=await Promise.all(variants.map(
                            async v=>({variant:v,...await store.status(
                                manifestForVariant(otherProvider,v))})));
                        const dictionary=provider==='onnx'
                            ? await store.verifyAndPruneCorrupt(dictionaryManifest()):null;
                        return {model,otherProvider:otherStatus,networkOffline:true,
                            dictionaryStillVerified:dictionary?
                                dictionary.ready&&dictionary.removedAssets===0&&
                                dictionary.missingAssets===0:null};
                    })().then(done,e=>done({error:String(e)}));
                """, provider, model_variant)
                if (removal.get("error") or
                        removal.get("model", {}).get("ready") or
                        removal.get("model", {}).get("storedBytes") != 0 or
                        removal.get("otherProvider") !=
                        origin_model_acceptance["otherProviderBefore"] or
                        (provider == "onnx" and not
                         removal.get("dictionaryStillVerified"))):
                    raise RuntimeError("Firefox offline " + provider +
                                       " Remove affected other caches or left bytes: " +
                                       str(removal))
                origin_model_acceptance["offlineUiRemoval"] = removal
            result = {"status": "passed" if metrics.get("success") else "failed",
                "browser": driver.capabilities.get("browserVersion"), "extensionId": addon_id,
                "preflight": preflight, "provider": provider, provider: metrics,
                "dictionaryCacheAcceptance": dictionary_cache_acceptance,
                "dictionaryReloadAcceptance": dictionary_reload_acceptance,
                "dictionaryUiDownloadAcceptance": dictionary_ui_acceptance,
                "originDownload": origin_download,
                "originModelAcceptance": origin_model_acceptance,
                "onnxPlaybackAcceptance": playback_acceptance,
                "onnxOverlayAcceptance": overlay_acceptance,
                "localBenchmarkAcceptance": benchmark_acceptance,
                "epubReaderAcceptance": epub_reader_acceptance,
                "articleSelectionAcceptance": article_selection_acceptance,
                "longFormMemoryAcceptance": long_form_memory_acceptance,
                "offlineAttempted": True,
                "offlineInference": metrics.get("success") is True,
                "cachePopulation": (
                    provider + " model downloaded through real Firefox UI from pinned HTTPS origin; no loopback preload"
                    if origin_download else
                    "model weights preloaded over authenticated loopback; dictionary tested with pinned HTTPS CORS/SRI and real Download/Cancel/Retry/Remove UI"),
                "scope": "Firefox/Linux MV3 offline " + provider +
                         " CPU synthesis; no subjective audio-quality acceptance"}
            print("FIREFOX REAL INFERENCE", json.dumps(result), flush=True)
            if not metrics.get("success"):
                raise RuntimeError("Firefox model-backed " + provider + " inference failed")
        except Exception as exc:
            result["status"] = "failed"
            result["error"] = str(exc)
            if isinstance(exc, FirefoxOriginModelVerificationError):
                # Preserve full typed cache-verifier results even if the
                # high-level model origin acceptance gate rejects the run.
                result["originModelAcceptance"] = {
                    **exc.report, "acceptancePassed": False}
            if "dictionary_cache_acceptance" in locals():
                result["dictionaryCacheAcceptance"] = dictionary_cache_acceptance
            if "dictionary_reload_acceptance" in locals():
                result["dictionaryReloadAcceptance"] = dictionary_reload_acceptance
            if "dictionary_ui_acceptance" in locals():
                result["dictionaryUiDownloadAcceptance"] = dictionary_ui_acceptance
            if "origin_model_acceptance" in locals() and origin_model_acceptance is not None:
                result["originModelAcceptance"] = origin_model_acceptance
            if "playback_acceptance" in locals() and playback_acceptance is not None:
                result["onnxPlaybackAcceptance"] = playback_acceptance
            if "overlay_acceptance" in locals() and overlay_acceptance is not None:
                result["onnxOverlayAcceptance"] = overlay_acceptance
            if "benchmark_acceptance" in locals() and benchmark_acceptance is not None:
                result["localBenchmarkAcceptance"] = benchmark_acceptance
            if "epub_reader_acceptance" in locals() and epub_reader_acceptance is not None:
                result["epubReaderAcceptance"] = epub_reader_acceptance
            if ("article_selection_acceptance" in locals() and
                    article_selection_acceptance is not None):
                result["articleSelectionAcceptance"] = article_selection_acceptance
            if ("long_form_memory_acceptance" in locals() and
                    long_form_memory_acceptance is not None):
                result["longFormMemoryAcceptance"] = long_form_memory_acceptance
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
