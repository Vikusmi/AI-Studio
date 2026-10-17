// Studio for macOS: a native window around the local Studio server.
// Starts the bundled Node server (or reuses one that is already running, e.g. started by Claude's MCP),
// shows the editor in WebKit, and adds the Mac parts a browser tab can't: menu bar, Dock icon,
// Save dialogs for exports, an Open dialog for images, and window state that's remembered.
import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var titleWatch: NSKeyValueObservation?
    let port = ProcessInfo.processInfo.environment["STUDIO_PORT"] ?? "4777"
    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Studio")

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Studio"
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(srgbRed: 0.98, green: 0.98, blue: 0.976, alpha: 1)
        window.minSize = NSSize(width: 960, height: 600)
        window.tabbingMode = .disallowed
        if !window.setFrameUsingName("StudioMain") { window.center() }
        window.setFrameAutosaveName("StudioMain")

        let cfg = WKWebViewConfiguration()
        cfg.preferences.isElementFullscreenEnabled = true
        cfg.applicationNameForUserAgent = "StudioApp"
        cfg.userContentController.add(self, name: "studioTheme")
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        window.contentView = web
        titleWatch = web.observe(\.title) { [weak self] w, _ in
            if let t = w.title, !t.isEmpty { self?.window.title = t }
        }
        web.loadHTMLString("""
            <body style="margin:0;height:100vh;display:grid;place-items:center;background:#f1f1ef;font:13px -apple-system;color:#86868b">
            <div style="text-align:center"><div style="width:14px;height:14px;border-radius:50%;background:#ff4f1f;margin:0 auto 12px"></div>Starting Studio…</div></body>
            """, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global(qos: .userInitiated).async {
            let ok = self.ensureServer()
            DispatchQueue.main.async {
                // `open -a Studio --args --edit` opens straight into the editor (used for checks)
                let start = CommandLine.arguments.contains("--edit") ? URL(string: "#/edit", relativeTo: self.base)! : self.base
                if ok { self.web.load(URLRequest(url: start)) }
                else { self.fail("Studio's server didn't start. Make sure Node.js is installed (nodejs.org), then open Studio again.\n\nLog: \(self.dataDir.path)/server.log") }
            }
        }
    }

    // the page tells us its theme: the window (title bar, background) follows it
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let d = m.body as? [String: String], let pref = d["pref"], let theme = d["theme"] else { return }
        DispatchQueue.main.async {
            // "auto" lets macOS decide; light / dark force the whole app
            switch pref {
            case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
            case "light": NSApp.appearance = NSAppearance(named: .aqua)
            default: NSApp.appearance = nil
            }
            self.window.backgroundColor = theme == "dark" ? NSColor(srgbRed: 0.13, green: 0.13, blue: 0.14, alpha: 1) : NSColor(srgbRed: 0.98, green: 0.98, blue: 0.976, alpha: 1)
        }
    }

    // ---------- the local server ----------
    func alive() -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("api/ping"))
        req.timeoutInterval = 1
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, r, _ in ok = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return ok
    }
    func ensureServer() -> Bool {
        if alive() { return true }
        guard let res = Bundle.main.resourceURL else { return false }
        let script = res.appendingPathComponent("app/server/server.js")
        let fm = FileManager.default
        var node = Bundle.main.object(forInfoDictionaryKey: "StudioNode") as? String ?? ""
        if !fm.isExecutableFile(atPath: node) {
            node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first { fm.isExecutableFile(atPath: $0) } ?? ""
        }
        guard !node.isEmpty else { return false }
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let logURL = dataDir.appendingPathComponent("server.log")
        fm.createFile(atPath: logURL.path, contents: nil)
        let log = try? FileHandle(forWritingTo: logURL)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        do { try p.run() } catch { return false }
        server = p
        for _ in 0..<75 { if alive() { return true }; Thread.sleep(forTimeInterval: 0.2) }
        return false
    }
    func applicationWillTerminate(_ note: Notification) {
        // SIGTERM lets the server save the open project before it exits
        server?.terminate()
        server?.waitUntilExit()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func fail(_ msg: String) {
        let a = NSAlert()
        a.messageText = "Studio couldn't start"
        a.informativeText = msg
        a.runModal()
        NSApp.terminate(nil)
    }

    // ---------- menu bar ----------
    func js(_ code: String) { web.evaluateJavaScript(code, completionHandler: nil) }
    @objc func newProject() { js("window.studio && studio.newProject()") }
    @objc func goHome() { js("window.studio && studio.home()") }
    @objc func present() { js("window.studio && studio.present()") }
    @objc func previewEmail() { js("window.studio && studio.preview()") }
    @objc func togglePanels() { js("window.studio && studio.panels()") }
    @objc func cycleTheme() { js("window.studio && studio.theme()") }
    @objc func fitAll() { js("window.studio && studio.fit()") }
    @objc func reload() { web.reload() }
    @objc func openProjectsFolder() { NSWorkspace.shared.open(dataDir.appendingPathComponent("projects")) }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            if let t = target { i.target = t }
            return i
        }
        func top(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem()
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            holder.submenu = m
            main.addItem(holder)
        }
        top("Studio", [
            item("About Studio", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide Studio", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Studio", #selector(NSApplication.terminate(_:)), "q"),
        ])
        top("File", [
            item("New Project", #selector(newProject), "n", target: self),
            item("All Projects", #selector(goHome), "h", [.command, .shift], target: self),
            item("Show Projects in Finder", #selector(openProjectsFolder), target: self),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        // no Undo/Redo here on purpose: ⌘Z goes to the canvas, which keeps one history shared with Claude
        top("Edit", [
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        top("View", [
            item("Hide / Show Side Panels   (⌘\\)", #selector(togglePanels), target: self),  // the shortcut lives in the page: a native key equivalent would toggle twice
            item("Switch Theme (Auto / Light / Dark)", #selector(cycleTheme), "l", [.command, .shift], target: self),
            .separator(),
            item("Zoom to Fit", #selector(fitAll), target: self),
            item("Preview Email…", #selector(previewEmail), "e", [.command, .option], target: self),
            item("Present", #selector(present), "p", [.command, .option], target: self),
            .separator(),
            item("Reload", #selector(reload), "r", target: self),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let win = NSMenuItem()
        let wm = NSMenu(title: "Window")
        wm.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        wm.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        win.submenu = wm
        main.addItem(win)
        NSApp.mainMenu = main
        NSApp.windowsMenu = wm
    }

    // ---------- links, downloads, file pickers ----------
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if a.shouldPerformDownload { decisionHandler(.download); return }
        if let u = a.request.url, let host = u.host, host != "127.0.0.1", host != "localhost", u.scheme?.hasPrefix("http") == true, a.targetFrame?.isMainFrame != false, a.navigationType == .linkActivated {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let h = r.response as? HTTPURLResponse, let cd = h.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().contains("attachment") {
            decisionHandler(.download); return
        }
        decisionHandler(r.canShowMIMEType || !r.isForMainFrame ? .allow : .download)
    }
    func webView(_ w: WKWebView, navigationAction: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
    func webView(_ w: WKWebView, navigationResponse: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }
    func download(_ d: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { resp in
            guard resp == .OK, let url = panel.url else { completionHandler(nil); return }
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }
    func download(_ d: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let a = NSAlert(); a.messageText = "Export failed"; a.informativeText = error.localizedDescription
        a.beginSheetModal(for: window)
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        // only when the server went away (e.g. it was restarted); a navigation that became a download also "fails" here
        let code = (e as NSError).code
        guard code == NSURLErrorCannotConnectToHost || code == NSURLErrorNetworkConnectionLost || code == NSURLErrorTimedOut else { return }
        DispatchQueue.global().async {
            if self.ensureServer() { DispatchQueue.main.async { self.web.load(URLRequest(url: self.base)) } }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
