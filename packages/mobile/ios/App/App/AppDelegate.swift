import UIKit
import Capacitor
import GameController
import WebKit
import WidgetKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

/// Bridge subclass (referenced from Main.storyboard) that stamps the hardware-keyboard
/// state as a document-start user script, so the web layer always sees it — injecting
/// later from the scene lifecycle raced page load and lost on first launch.
/// The scripts must be added in capacitorDidLoad(), NOT webViewConfiguration(for:): Capacitor's
/// prepareWebView replaces the configuration's userContentController with its own right after
/// calling webViewConfiguration(for:), which silently discards any user script added there.
/// capacitorDidLoad() runs after that swap but before loadWebView() starts the initial page load.
class BridgeViewController: CAPBridgeViewController {
    private var keyboardObservers: [NSObjectProtocol] = []

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // GCKeyboard is the only authoritative answer to "is a hardware keyboard
        // attached?". The web layer can otherwise only INFER it from a keyboard
        // that never appears, which costs the user one focus before the layout
        // settles — so the state is stamped at document start and kept live.
        //
        // At this point GameController has usually NOT finished discovery yet, so
        // an already-attached keyboard still reads as nil here. The stamp is only
        // the optimistic first answer; refreshHardwareKeyboardState() below is
        // what actually settles it once the page exists.
        let attached = GCKeyboard.coalesced != nil
        let source = """
        window.__PICHAMBER_HARDWARE_KEYBOARD__ = \(attached ? "true" : "false");
        """
        webView?.configuration.userContentController.addUserScript(
            WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        observeHardwareKeyboard()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Two races make a single early publish unreliable for a keyboard that was
        // ALREADY attached at launch, which is why it only ever worked when the
        // user plugged one in afterwards:
        //  - GCKeyboardDidConnect for a pre-attached keyboard fires during launch,
        //    before the web page exists, so its evaluateJavaScript lands in a
        //    context the page load then throws away;
        //  - GameController can populate `coalesced` a beat after launch anyway.
        // Re-publishing across the first seconds covers both; the web side adopts
        // idempotently, so repeats are free.
        refreshHardwareKeyboardState()
        for delay in [0.3, 1.0, 2.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.refreshHardwareKeyboardState()
            }
        }
    }

    /// Re-read GameController and publish the current answer to the web layer.
    /// Also called when the app returns to the foreground — a keyboard can be
    /// attached or detached while backgrounded, with no notification delivered.
    func refreshHardwareKeyboardState() {
        publishHardwareKeyboardState(GCKeyboard.coalesced != nil)
    }

    private func observeHardwareKeyboard() {
        let center = NotificationCenter.default
        keyboardObservers = [
            center.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) { [weak self] _ in
                self?.publishHardwareKeyboardState(true)
            },
            center.addObserver(forName: .GCKeyboardDidDisconnect, object: nil, queue: .main) { [weak self] _ in
                // A second keyboard may still be attached (Stage Manager, dock swaps).
                self?.publishHardwareKeyboardState(GCKeyboard.coalesced != nil)
            },
        ]
    }

    private func publishHardwareKeyboardState(_ attached: Bool) {
        let value = attached ? "true" : "false"
        webView?.evaluateJavaScript("""
        window.__PICHAMBER_HARDWARE_KEYBOARD__ = \(value);
        window.dispatchEvent(new CustomEvent('oc:hardware-keyboard', { detail: { attached: \(value) } }));
        """)
    }

    deinit {
        for observer in keyboardObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

// iOS 26 (TN3187) requires apps built with the latest SDK to adopt the UIScene
// lifecycle. Capacitor 7's template still uses the legacy window setup, so we host a
// minimal scene delegate here that loads the Main storyboard (CAPBridgeViewController)
// and forwards deep links / universal links into Capacitor's delegate proxy.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        window.makeKeyAndVisible()

        configureWebViewChrome()

        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
        }
        if let userActivity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // Re-assert in case the WebView wasn't ready at scene-connect time, or the
        // effect was re-enabled while backgrounded.
        configureWebViewChrome()

        // A keyboard can be attached or detached while the app is backgrounded,
        // with no GameController notification delivered to it.
        (window?.rootViewController as? BridgeViewController)?.refreshHardwareKeyboardState()

        // Refresh the widgets' session overview now that the WebView is loaded and state is fresh.
        writeWidgetSnapshot()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        // Capture the latest session overview before the app leaves the foreground, so the
        // home/lock-screen/Control Center widgets reflect what the user just saw.
        writeWidgetSnapshot()
    }

    private static let widgetAppGroup = "group.com.pichamber.app"
    private static let widgetSnapshotKey = "widgetSnapshot"

    /// Pulls the session overview JSON from the web layer (window.__PICHAMBER_WIDGET_SNAPSHOT__),
    /// stores it in the shared App Group, and reloads the widget timelines. localStorage/stores
    /// aren't reachable from the widget process, so this is how the bundled UI feeds the widgets —
    /// no server involved. Failures are ignored so a transient read never clobbers a good snapshot.
    private func writeWidgetSnapshot() {
        guard let bridge = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridge.webView else { return }
        let js = "(typeof window.__PICHAMBER_WIDGET_SNAPSHOT__ === 'function') ? window.__PICHAMBER_WIDGET_SNAPSHOT__() : null"
        webView.evaluateJavaScript(js) { result, _ in
            guard let json = result as? String, !json.isEmpty,
                  let defaults = UserDefaults(suiteName: SceneDelegate.widgetAppGroup) else { return }
            // Only write + reload when the overview actually changed. We write this on every
            // scene activate/resign; reloading WidgetCenter every time burns the WidgetKit
            // reload budget and leaves some widgets stale (the snapshot no longer contains a
            // per-call timestamp, so identical overviews compare equal).
            if defaults.string(forKey: SceneDelegate.widgetSnapshotKey) == json { return }
            defaults.set(json, forKey: SceneDelegate.widgetSnapshotKey)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// iOS 26 (Liquid Glass) automatically applies a "scroll edge effect" — a blur +
    /// appearance-coloured dim — to the top/bottom of a scroll view beneath the system
    /// bars. On the full-screen WKWebView that renders as a dark band behind the status
    /// bar in Dark Mode (independent of the in-app theme). Hide it so the web content
    /// (which paints its own themed background) is what shows under the status bar.
    private func configureWebViewChrome() {
        guard let bridge = window?.rootViewController as? CAPBridgeViewController,
              let webView = bridge.webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        if #available(iOS 26.0, *) {
            // KVC keeps this compiling with pre-26 SDKs, but the effect object is a
            // UIScrollEdgeEffect — NOT a UIView — so it must be handled as a plain
            // NSObject ("hidden" is the ObjC key behind isHidden). The previous
            // `as? UIView` cast silently returned nil and left the system's dark
            // edge band visible behind the status bar.
            for key in ["topEdgeEffect", "bottomEdgeEffect"] {
                guard webView.scrollView.responds(to: NSSelectorFromString(key)) else { continue }
                (webView.scrollView.value(forKey: key) as? NSObject)?.setValue(true, forKey: "hidden")
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity) { _ in }
    }
}
