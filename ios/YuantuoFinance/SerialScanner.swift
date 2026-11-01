#if canImport(UIKit) && canImport(AVFoundation)
import SwiftUI
import AVFoundation
import UIKit

/// Captures text only. Inventory validation and the final write remain on the server.
struct SerialScannerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let title: String
    let continuous: Bool
    let onScan: (String) -> Void
    @State private var entered = ""
    @State private var accepted: [String] = []
    @State private var seen: Set<String>
    @State private var cameraMessage: String?
    @State private var feedback = "对准单个串号或商品条码，识别后请核对。"
    @State private var active = true

    init(title: String = "扫描串号", existingCodes: [String] = [], continuous: Bool = true, onScan: @escaping (String) -> Void) {
        self.title = title
        self.continuous = continuous
        self.onScan = onScan
        _seen = State(initialValue: Set(existingCodes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SerialCameraPreview(active: active && scenePhase == .active, onCode: accept, onStatus: { cameraMessage = $0 })
                        .frame(height: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("条码扫描相机")
                    if let cameraMessage {
                        Text(cameraMessage).font(.footnote).foregroundStyle(.secondary)
                        if AVCaptureDevice.authorizationStatus(for: .video) == .denied,
                           let url = URL(string: UIApplication.openSettingsURLString) {
                            Link("打开设置，允许相机访问", destination: url)
                        }
                    }
                    Text(feedback).font(.footnote).accessibilityLabel(feedback)
                }
                Section("也可手动输入") {
                    TextField("串号或商品条码", text: $entered)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { accept(entered) }
                    Button("添加") { accept(entered) }.disabled(entered.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if !accepted.isEmpty {
                    Section("本次已录入 \(accepted.count) 条") {
                        ForEach(accepted.reversed(), id: \.self) { code in
                            Label(code, systemImage: "checkmark.circle.fill").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { active = false; dismiss() } } }
            .onDisappear { active = false }
        }
    }

    private func accept(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !value.isEmpty, value.utf16.count <= 128, value.range(of: "[\\s\\x00-\\x1F\\x7F]", options: .regularExpression) == nil else {
            feedback = "请录入单个完整条码，不超过 128 字符，不能包含空白或控制字符。"
            return
        }
        guard seen.insert(value.uppercased()).inserted else { feedback = "已录入此条码，未重复添加。"; return }
        accepted.append(value)
        entered = ""
        feedback = "已添加：\(value)"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onScan(value)
        if !continuous { active = false; dismiss() }
    }
}

private struct SerialCameraPreview: UIViewControllerRepresentable {
    let active: Bool
    let onCode: (String) -> Void
    let onStatus: (String?) -> Void
    func makeUIViewController(context: Context) -> SerialCameraController {
        let controller = SerialCameraController()
        controller.onCode = onCode
        controller.onStatus = onStatus
        controller.requestedActive = active
        return controller
    }
    func updateUIViewController(_ controller: SerialCameraController, context: Context) {
        controller.onCode = onCode
        controller.onStatus = onStatus
        controller.requestedActive = active
        controller.updateCapture()
    }
    static func dismantleUIViewController(_ controller: SerialCameraController, coordinator: ()) { controller.stopCapture() }
}

private final class SerialCaptureEngine: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "finance.serial-camera")
    private var configured = false
    var onCode: ((String) -> Void)?
    var onFailure: ((String) -> Void)?
    func setRunning(_ running: Bool) {
        queue.async { [self] in
            if !running { if session.isRunning { session.stopRunning() }; return }
            if !configured {
                guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
                    fail("当前设备无法使用相机，请手动输入串号。")
                    return
                }
                session.beginConfiguration()
                guard session.canAddInput(input) else { session.commitConfiguration(); fail("相机暂不可用，请手动输入。"); return }
                session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard session.canAddOutput(output) else {
                    session.removeInput(input); session.commitConfiguration(); fail("此设备不支持条码识别，请手动输入。"); return
                }
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                let types: [AVMetadataObject.ObjectType] = [.code128, .code39, .code93, .ean13, .ean8, .upce, .qr, .dataMatrix, .pdf417, .itf14, .interleaved2of5]
                output.metadataObjectTypes = types.filter { output.availableMetadataObjectTypes.contains($0) }
                session.commitConfiguration()
                configured = true
            }
            if !session.isRunning { session.startRunning() }
        }
    }
    private func fail(_ message: String) { DispatchQueue.main.async { [weak self] in self?.onFailure?(message) } }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        // One physical label per frame; the SwiftUI layer deduplicates successive frames.
        if let value = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first { onCode?(value) }
    }
}

private final class SerialCameraController: UIViewController {
    var onCode: (String) -> Void = { _ in }
    var onStatus: (String?) -> Void = { _ in }
    var requestedActive = true
    private var visible = false
    private var captureRequested = false
    private var askingPermission = false
    private var hasReportedStatus = false
    private var lastStatus: String?
    private let engine = SerialCaptureEngine()
    private var preview: AVCaptureVideoPreviewLayer?
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .secondarySystemBackground
        let layer = AVCaptureVideoPreviewLayer(session: engine.session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
        engine.onCode = { [weak self] value in
            guard let self, self.visible, self.requestedActive, UIApplication.shared.applicationState == .active else { return }
            self.onCode(value)
        }
        engine.onFailure = { [weak self] text in self?.reportStatus(text) }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.stopEngine() })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.updateCapture() })
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: engine.session, queue: .main) { [weak self] _ in self?.reportStatus("相机已暂停，可继续手动输入。") })
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: engine.session, queue: .main) { [weak self] _ in self?.stopEngine(); self?.updateCapture() })
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: engine.session, queue: .main) { [weak self] _ in self?.engine.setRunning(false); self?.reportStatus("相机暂时无法运行，请关闭后重试或手动输入。") })
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); visible = true; updateCapture() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stopCapture() }
    func stopCapture() { visible = false; stopEngine() }
    private func stopEngine() { captureRequested = false; engine.setRunning(false) }
    func updateCapture() {
        guard isViewLoaded, visible, requestedActive, UIApplication.shared.applicationState == .active else { stopEngine(); return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            // SwiftUI may update the preview for every scanned label. Start only once,
            // and preserve any unavailable-camera message until a new activation.
            guard !captureRequested else { return }
            captureRequested = true
            reportStatus(nil)
            engine.setRunning(true)
        case .notDetermined:
            guard !askingPermission else { return }
            askingPermission = true
            AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
                DispatchQueue.main.async { self?.askingPermission = false; self?.updateCapture() }
            }
        case .denied, .restricted:
            stopEngine()
            reportStatus("未获得相机权限，可以在下方手动输入。")
        @unknown default:
            stopEngine()
            reportStatus("相机不可用，可以在下方手动输入。")
        }
    }
    private func reportStatus(_ message: String?) {
        guard !hasReportedStatus || lastStatus != message else { return }
        hasReportedStatus = true; lastStatus = message
        // updateUIViewController may run inside a SwiftUI view update.
        DispatchQueue.main.async { [weak self] in self?.onStatus(message) }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver); engine.setRunning(false) }
}
#endif
