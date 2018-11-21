/// <reference path="./node_modules/tns-platform-declarations/ios.d.ts" />

import * as fs from "tns-core-modules/file-system";
import * as platform from "tns-core-modules/platform";
import { profile } from "tns-core-modules/profiling";
import { traceMessageType } from "tns-core-modules/ui/core/view";

import { webViewBridgeJsCodePromise } from "./nativescript-webview-bridge-loader";
import { autoInjectJSBridgeProperty, WebViewExtBase } from "./webview-ext-common";
import { UIWebViewDelegateImpl } from "./webview-ext.uiwebview";
import { WKNavigationDelegateImpl, WKScriptMessageHandlerImpl } from "./webview-ext.wkwebview";

export * from "./webview-ext-common";

let registeredCustomNSURLProtocol = false;

let webViewBridgeJsCode: string;
webViewBridgeJsCodePromise.then((scriptCode) => (webViewBridgeJsCode = scriptCode));

export class WebViewExt extends WebViewExtBase {
    nativeViewProtected: WKWebView | UIWebView;

    protected _wkWebViewConfiguration: WKWebViewConfiguration;
    protected _wkNavigationDelegate: WKNavigationDelegateImpl;
    protected _wkCustomUrlSchemeHandler: CustomUrlSchemeHandler;
    protected _wkUserContentController: WKUserContentController;
    protected _wkUserScriptInjectWebViewBrigde: WKUserScript;
    protected _wkUserScriptViewPortCode: WKUserScript;
    protected _wkNamedUserScripts: Array<{
        name: string;
        wkUserScript: WKUserScript;
    }>;

    protected _uiWebViewDelegate: UIWebViewDelegateImpl;

    protected get _uiWebView(): UIWebView | void {
        if (this.isUIWebView) {
            return this.nativeViewProtected as UIWebView;
        }
    }

    protected get _wkWebView(): WKWebView | void {
        if (this.isWKWebView) {
            return this.nativeViewProtected as WKWebView;
        }
    }

    public createNativeView(): WKWebView | UIWebView {
        if (Number(platform.device.sdkVersion) >= 11) {
            return this.createNativeViewIOS11Plus();
        } else {
            return this.createNativeViewIOS9and10();
        }
    }

    public initNativeView() {
        super.initNativeView();
        if (this._wkWebView) {
            this.initNativeViewIOS11Plus();
        } else if (this._uiWebView) {
            this.initNativeViewIOS9and10();
        }
    }

    public disposeNativeView() {
        if (this._wkWebView) {
            this.disposeNativeViewIOS11Plus();
        } else if (this._uiWebView) {
            this.disposeNativeViewIOS9and10();
        }

        super.disposeNativeView();
    }

    protected createNativeViewIOS11Plus() {
        this.isUIWebView = false;
        this.isWKWebView = true;

        const configuration = (this._wkWebViewConfiguration = WKWebViewConfiguration.new());

        const jsBridgeScript = `
            ${webViewBridgeJsCode};
        `;

        this._wkUserScriptInjectWebViewBrigde = this.createWkUserScript(jsBridgeScript);

        this._wkUserScriptViewPortCode = this.createWkUserScript(
            `
        (function() {
            let meta = document.querySelector(
                'head meta[name="viewport"]',
            );
            if (!meta) {
                meta = document.createElement("meta");
                document.head.appendChild(meta);
            }

            meta.setAttribute("name", "viewport");
            meta.setAttribute("content", "initial-scale=1.0");
        })();
        `,
        );
        const messageHandler = WKScriptMessageHandlerImpl.initWithOwner(new WeakRef(this));
        const wkUController = (this._wkUserContentController = WKUserContentController.new());
        wkUController.addScriptMessageHandlerName(messageHandler, "nsBridge");
        configuration.userContentController = wkUController;
        configuration.preferences.setValueForKey(true, "allowFileAccessFromFileURLs");
        configuration.preferences.setValueForKey(true, "allowUniversalAccessFromFileURLs");

        this._wkCustomUrlSchemeHandler = new CustomUrlSchemeHandler();
        this._wkWebViewConfiguration.setURLSchemeHandlerForURLScheme(this._wkCustomUrlSchemeHandler, this.interceptScheme);

        const webview = new WKWebView({
            frame: CGRectZero,
            configuration: configuration,
        });

        this._wkNamedUserScripts = [];

        return webview;
    }

    protected initNativeViewIOS11Plus() {
        this._wkNavigationDelegate = WKNavigationDelegateImpl.initWithOwner(new WeakRef(this));

        this.loadWKUserScripts();
    }

    protected disposeNativeViewIOS11Plus() {
        this._wkNavigationDelegate = null;
    }

    protected createNativeViewIOS9and10() {
        this.isUIWebView = true;
        this.isWKWebView = false;

        if (!registeredCustomNSURLProtocol) {
            NSURLProtocol.registerClass(CustomNSURLProtocol as any);
            registeredCustomNSURLProtocol = true;
        }

        const uiWebView = UIWebView.new();

        uiWebView.scrollView.bounces = false;
        uiWebView.scrollView.scrollEnabled = false;
        uiWebView.scalesPageToFit = false;

        return uiWebView;
    }

    protected initNativeViewIOS9and10() {
        this._uiWebViewDelegate = UIWebViewDelegateImpl.initWithOwner(new WeakRef(this));
    }

    protected disposeNativeViewIOS9and10() {
        this._uiWebViewDelegate = null;
    }

    protected async injectWebViewBridge() {
        if (this._wkWebView) {
            // Loaded via WkUserScripts
            return;
        }

        return await super.injectWebViewBridge();
    }

    public async executeJavaScript<T>(scriptCode: string, stringifyResult = true): Promise<T> {
        if (stringifyResult) {
            scriptCode = `
                (function(window) {
                    var result = null;

                    try {
                        result = ${scriptCode.trim()};
                    } catch (err) {
                        return JSON.stringify({
                            error: true,
                            message: err.message,
                            stack: err.stack
                        });
                    }

                    try {
                        return JSON.stringify(result);
                    } catch (err) {
                        return result;
                    }
                })(window);
            `;
        }

        scriptCode = scriptCode.trim();

        let result = await new Promise<T>((resolve, reject) => {
            if (this._wkWebView) {
                this._wkWebView.evaluateJavaScriptCompletionHandler(scriptCode, (result, error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(result);
                });
            } else if (this._uiWebView) {
                try {
                    const result = this._uiWebView.stringByEvaluatingJavaScriptFromString(scriptCode);
                    resolve(result as any);
                } catch (error) {
                    reject(error);
                }
            }
        });

        result = await this.parseWebViewJavascriptResult(result);

        const r = result as any;
        if (r && typeof r === "object" && r.error) {
            const error = new Error(r.message);
            (error as any).webStack = r.stack;
            throw error;
        }

        return result;
    }

    @profile
    public onLoaded() {
        super.onLoaded();

        if (this._wkWebView) {
            this._wkWebView.navigationDelegate = this._wkNavigationDelegate;
        } else if (this._uiWebView) {
            this._uiWebView.delegate = this._uiWebViewDelegate;
        }
    }

    public onUnloaded() {
        if (this._wkWebView) {
            this._wkWebView.navigationDelegate = null;
        } else if (this._uiWebView) {
            this._uiWebView.delegate = null;
        }

        super.onUnloaded();
    }

    public stopLoading() {
        if (this._wkWebView) {
            this._wkWebView.stopLoading();
        } else if (this._uiWebView) {
            this._uiWebView.stopLoading();
        }
    }

    public _loadUrl(src: string) {
        const nsURL = NSURL.URLWithString(src);
        if (this._wkWebView) {
            if (src.startsWith("file:///")) {
                const nsReadAccessUrl = NSURL.URLWithString(src);
                this.writeTrace(`WebViewExt<ios>._loadUrl("${src}") -> this._wkWebView.loadFileURLAllowingReadAccessToURL("${nsURL}", "${nsReadAccessUrl}"`);
                this._wkWebView.loadFileURLAllowingReadAccessToURL(nsURL, nsReadAccessUrl);
            } else {
                const nsRequestWithUrl = NSURLRequest.requestWithURL(nsURL);
                this.writeTrace(`WebViewExt<ios>._loadUrl("${src}") -> this._wkWebView.loadRequest("${nsRequestWithUrl}"`);
                this._wkWebView.loadRequest(nsRequestWithUrl);
            }
        } else if (this._uiWebView) {
            const nsRequestWithUrl = NSURLRequest.requestWithURL(nsURL);
            this.writeTrace(`WebViewExt<ios>._loadUrl("${src}") -> this._uiWebView.loadRequest("${nsRequestWithUrl}"`);
            this._uiWebView.loadRequest(nsRequestWithUrl);
        }
    }

    public _loadData(content: string) {
        const nsURL = NSURL.alloc().initWithString(`file:///${fs.knownFolders.currentApp().path}/`);
        if (this._wkWebView) {
            this.writeTrace(`WebViewExt<ios>._loadUrl(content) -> this._wkWebView.loadHTMLStringBaseURL("${nsURL}")`);
            this._wkWebView.loadHTMLStringBaseURL(content, nsURL);
        } else if (this._uiWebView) {
            this.writeTrace(`WebViewExt<ios>._loadUrl(content) -> this._uiWebView.loadHTMLStringBaseURL("${nsURL}")`);
            this._uiWebView.loadHTMLStringBaseURL(content, nsURL);
        }
    }

    public get canGoBack(): boolean {
        if (this._wkWebView) {
            return !!this._wkWebView.canGoBack;
        } else if (this._uiWebView) {
            return !!this._uiWebView.canGoBack;
        } else {
            return false;
        }
    }

    public get canGoForward(): boolean {
        if (this._wkWebView) {
            return !!this._wkWebView.canGoForward;
        } else if (this._uiWebView) {
            return !!this._uiWebView.canGoForward;
        } else {
            return false;
        }
    }

    public goBack() {
        if (this._wkWebView) {
            this._wkWebView.goBack();
        } else if (this._uiWebView) {
            this._uiWebView.goBack();
        }
    }

    public goForward() {
        if (this._wkWebView) {
            this._wkWebView.goForward();
        } else if (this._uiWebView) {
            this._uiWebView.goForward();
        }
    }

    public reload() {
        if (this._wkWebView) {
            this._wkWebView.reload();
        } else if (this._uiWebView) {
            this._uiWebView.reload();
        }
    }

    public registerLocalResource(resourceName: string, path: string) {
        resourceName = this.fixLocalResourceName(resourceName);

        const filepath = this.resolveLocalResourceFilePath(path);
        if (!filepath) {
            this.writeTrace(`WebViewExt<ios>.registerLocalResource("${resourceName}", "${path}") -> file doesn't exist`, traceMessageType.error);
            return;
        }

        this.writeTrace(`WebViewExt<ios>.registerLocalResource("${resourceName}", "${path}") -> file: "${filepath}"`);

        if (this._wkWebView) {
            this._wkCustomUrlSchemeHandler.registerLocalResourceForKeyFilepath(resourceName, filepath);
        } else if (this._uiWebView) {
            CustomNSURLProtocol.registerLocalResourceForKeyFilepath(resourceName, filepath);
        }
    }

    public unregisterLocalResource(resourceName: string) {
        this.writeTrace(`WebViewExt<ios>.unregisterLocalResource("${resourceName}")`);

        resourceName = this.fixLocalResourceName(resourceName);

        if (this._wkWebView) {
            this._wkCustomUrlSchemeHandler.unregisterLocalResourceForKey(resourceName);
        } else if (this._uiWebView) {
            CustomNSURLProtocol.unregisterLocalResourceForKey(resourceName);
        }
    }

    public getRegisteredLocalResource(resourceName: string) {
        resourceName = this.fixLocalResourceName(resourceName);

        let result: string;
        if (this._wkWebView) {
            result = this._wkCustomUrlSchemeHandler.getRegisteredLocalResourceForKey(resourceName);
        } else if (this._uiWebView) {
            result = CustomNSURLProtocol.getRegisteredLocalResourceForKey(resourceName);
        } else {
            throw new Error("Not implemented for UIWebView");
        }

        this.writeTrace(`WebViewExt<android>.getRegisteredLocalResource("${resourceName}") -> "${result}"`);
        return result;
    }

    public onUIWebViewEvent(url: string) {
        if (!this.isUIWebView) {
            this.writeTrace(`WebViewExt.onUIWebViewEvent("${url}") - only works for UIWebView`, traceMessageType.error);
            return;
        }

        if (!url.startsWith("js2ios")) {
            this.writeTrace(`WebViewExt.onUIWebViewEvent("${url}") - only supports js2ios-scheme`, traceMessageType.error);
            return;
        }

        try {
            const message = decodeURIComponent(url.replace(/^js2ios:/, ""));
            const { eventName, resId } = JSON.parse(message);
            this.executeJavaScript<any>(`window.nsWebViewBridge.getUIWebViewResponse(${JSON.stringify(resId)})`)
                .then((data) => {
                    this.onWebViewEvent(eventName, data);
                })
                .catch((err) => {
                    this.writeTrace(`WebViewExt.onUIWebViewEvent("${url}") - getUIWebViewResponse - ${err}`, traceMessageType.error);
                });
        } catch (err) {
            this.writeTrace(`WebViewExt.onUIWebViewEvent("${url})" - "${err}"`, traceMessageType.error);
        }
    }

    public getTitle() {
        return this.executeJavaScript<string>("document.title");
    }

    public autoLoadStyleSheetFile(resourceName: string, filepath: string, insertBefore?: boolean) {
        if (this._wkWebView) {
            resourceName = this.fixLocalResourceName(resourceName);
            if (filepath) {
                this.registerLocalResource(resourceName, filepath);
            }
            const href = `${this.interceptScheme}://${resourceName}`;
            const scriptCode = this.generaateLoadCSSFileScriptCode(href, insertBefore);

            this.addNamedUserScript(`auto-load-css-${resourceName}`, scriptCode);
        } else {
            return super.autoLoadStyleSheetFile(resourceName, filepath, insertBefore);
        }
    }

    public removeAutoLoadStyleSheetFile(resourceName: string) {
        resourceName = this.fixLocalResourceName(resourceName);
        this.removeNamedUserScript(`auto-load-css-${resourceName}`);
    }

    public autoLoadJavaScriptFile(resourceName: string, filepath: string) {
        if (this._wkWebView) {
            const fixedResourceName = this.fixLocalResourceName(resourceName);
            if (filepath) {
                this.registerLocalResource(fixedResourceName, filepath);
            }
            const href = `${this.interceptScheme}://${fixedResourceName}`;
            const scriptCode = this.generateLoadJavaScriptFileScriptCode(href);
            this.addNamedUserScript(href, scriptCode);
        } else {
            super.autoLoadJavaScriptFile(resourceName, filepath);
        }
    }

    public removeAutoLoadJavaScriptFile(resourceName: string) {
        if (this._wkWebView) {
            const fixedResourceName = this.fixLocalResourceName(resourceName);
            const href = `${this.interceptScheme}://${fixedResourceName}`;
            this.removeNamedUserScript(href);
        } else {
            super.removeAutoLoadJavaScriptFile(resourceName);
        }
    }

    protected addNamedUserScript(name: string, scriptCode: string) {
        if (!this._wkWebView) {
            return;
        }

        this.removeNamedUserScript(name);

        const wkUserScript = this.createWkUserScript(scriptCode);

        this._wkNamedUserScripts.push({ name, wkUserScript });

        this._wkUserContentController.addUserScript(wkUserScript);
    }

    protected createWkUserScript(scriptCode: string) {
        return WKUserScript.alloc().initWithSourceInjectionTimeForMainFrameOnly(`${scriptCode}`.trim(), WKUserScriptInjectionTime.AtDocumentEnd, true);
    }

    protected removeNamedUserScript(name: string) {
        if (!this._wkWebView) {
            return;
        }

        const idx = this._wkNamedUserScripts.findIndex((val) => val.name === name);
        if (idx === -1) {
            return;
        }

        this._wkNamedUserScripts.splice(idx, 1);

        this.loadWKUserScripts(this.autoInjectJSBridge);
    }

    protected loadWKUserScripts(autoInjectJSBridge = this.autoInjectJSBridge) {
        if (!this._wkWebView) {
            return;
        }

        this._wkUserContentController.removeAllUserScripts();

        if (!autoInjectJSBridge) {
            this._wkUserContentController.addUserScript(this._wkUserScriptViewPortCode);
            return;
        }

        this._wkUserContentController.addUserScript(this._wkUserScriptInjectWebViewBrigde);
        this._wkUserContentController.addUserScript(this._wkUserScriptViewPortCode);

        for (const { wkUserScript } of this._wkNamedUserScripts) {
            this._wkUserContentController.addUserScript(wkUserScript);
        }
    }

    [autoInjectJSBridgeProperty.setNative](enabled: boolean) {
        if (this._wkWebView) {
            this.loadWKUserScripts(enabled);
        }
    }
}
