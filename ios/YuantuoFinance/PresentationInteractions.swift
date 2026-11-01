import SwiftUI

// App-owned interactions. ShipSwift's existing search field is composed below;
// these presentation components are not additional ShipSwift APIs.
struct FinanceSegments: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var highlight
    @Binding var selection: String
    let title: String
    let options: [(String, String)]
    var body: some View {
        HStack(spacing: 4) {
            ForEach(options, id: \.0) { option in
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.88)) { selection = option.0 }
                } label: {
                    Text(option.1).font(.subheadline.weight(selection == option.0 ? .semibold : .regular))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(selection == option.0 ? FinanceStyle.accent : .secondary)
                        .background {
                            if selection == option.0 {
                                RoundedRectangle(cornerRadius: 12).fill(.background)
                                    .matchedGeometryEffect(id: "selection", in: highlight)
                            }
                        }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityAddTraits(selection == option.0 ? .isSelected : [])
            }
        }.padding(4).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityElement(children: .contain).accessibilityLabel(title)
            .sensoryFeedback(.selection, trigger: selection)
    }
}

struct ExpandingSearch: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var text: String
    let placeholder: String
    @State private var expanded = false
    var body: some View {
        HStack(spacing: 8) {
            if expanded {
                SWSearchBar(text: $text, placeholder: placeholder, autoFocus: true)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.85, anchor: .leading)))
                Button { setExpanded(false) } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("收起搜索，保留筛选条件")
            } else {
                Button { setExpanded(true) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass")
                        Text(text.isEmpty ? placeholder : "正在筛选：\(text)").lineLimit(1)
                        Spacer(minLength: 0)
                        if !text.isEmpty { Image(systemName: "line.3.horizontal.decrease.circle.fill") }
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.accessibilityHint(text.isEmpty ? "展开搜索框" : "已保留搜索条件，展开后可清除")
            }
        }.buttonStyle(FinancePressStyle())
    }
    private func setExpanded(_ value: Bool) {
        withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9)) { expanded = value }
    }
}

struct ExpenseCategoryPicker: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var selection: String
    @State private var expanded = false
    private let categories = ["日常支出", "工资", "房租", "人情往来", "资金费用", "其他费用"]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(animation) { expanded.toggle() }
            } label: {
                HStack { Text("费用类别"); Spacer(); Text(expanded ? "收起" : "展开全部").font(.caption); Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)) }
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "已展开" : selection)
            if expanded {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 108), spacing: 8)], spacing: 8) {
                    ForEach(categories, id: \.self) { category in chip(category) }
                }.transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) { ForEach(categories, id: \.self) { category in chip(category).id(category) } }
                    }.scrollIndicators(.hidden)
                        .onAppear { proxy.scrollTo(selection, anchor: .center) }
                        .onChange(of: selection) { _, value in withAnimation(animation) { proxy.scrollTo(value, anchor: .center) } }
                }
            }
        }.sensoryFeedback(.selection, trigger: selection)
    }
    private var animation: Animation? { reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.9) }
    private func chip(_ category: String) -> some View {
        Button { withAnimation(animation) { selection = category; expanded = false } } label: {
            HStack(spacing: 5) { if selection == category { Image(systemName: "checkmark") }; Text(category) }
                .font(.subheadline).padding(.horizontal, 12).frame(minHeight: 44)
                .foregroundStyle(selection == category ? FinanceStyle.accent : .primary)
                .background(FinanceStyle.accent.opacity(selection == category ? 0.12 : 0.035), in: Capsule())
                .overlay { Capsule().strokeBorder(FinanceStyle.accent.opacity(selection == category ? 0.65 : 0.12)) }
        }.buttonStyle(FinancePressStyle()).accessibilityAddTraits(selection == category ? .isSelected : [])
    }
}

struct ExpandingDatePicker: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var date: Date
    var title = "业务日期"
    @State private var expanded = false
    var body: some View {
        VStack(spacing: 8) {
            Button { withAnimation(animation) { expanded.toggle() } } label: {
                HStack { Label(title, systemImage: "calendar"); Spacer(); Text(BusinessDate.string(date)).monospacedDigit(); Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)) }
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "日历已展开" : "日历已收起")
            if expanded {
                DatePicker("选择" + title, selection: Binding(get: { date }, set: { value in
                    date = value
                    withAnimation(animation) { expanded = false }
                }), displayedComponents: .date)
                #if os(iOS)
                .datePickerStyle(.graphical)
                #endif
                .labelsHidden()
                .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.92, anchor: .top)))
            }
        }
    }
    private var animation: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9) }
}

struct EntrySummaryBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let title: String
    let summary: String
    let disabled: Bool
    let review: () -> Void
    @State private var expanded = false
    var body: some View {
        VStack(spacing: 10) {
            if expanded {
                ScrollView { Text(summary).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(12) }
                    .frame(maxHeight: 180)
                    .background(FinanceStyle.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
            HStack(spacing: 12) {
                Button { withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.9)) { expanded.toggle() } } label: {
                    HStack { VStack(alignment: .leading, spacing: 3) { Text("本笔摘要").font(.caption).foregroundStyle(.secondary); Text(title).font(.subheadline.bold()).lineLimit(2) }; Image(systemName: "chevron.up").rotationEffect(.degrees(expanded ? 180 : 0)) }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(expanded ? "已展开" : "已收起")
                Button("核对明细", action: review).font(.subheadline.bold()).padding(.horizontal, 16).frame(minHeight: 48)
                    .foregroundStyle(.white).background(FinanceStyle.accent, in: Capsule())
                    .buttonStyle(FinancePressStyle()).disabled(disabled)
            }
        }.padding(16).background(.regularMaterial)
    }
}

struct SaveConfirmationPanel: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var titleFocused: Bool
    let title: String
    let summary: String
    let state: SaveFeedbackState
    let message: String?
    let busy: Bool
    let confirm: () -> Void
    let close: () -> Void
    @State private var appeared = false
    private var heading: String {
        switch state {
        case .saved: return "已保存"
        case .saving: return "正在保存"
        case .uncertain: return "保存结果待确认"
        case .failed: return "本次未保存"
        case .ready: return "确认\(title)"
        }
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(appeared ? 0.3 : 0).ignoresSafeArea()
                    .onTapGesture { if state == .ready || state == .failed { close() } }
                    .accessibilityHidden(true)
                VStack(spacing: 16) {
                    HStack {
                        Group { if state == .saving { ProgressView() } else { Image(systemName: state == .saved ? "checkmark.circle.fill" : state == .uncertain || state == .failed ? "exclamationmark.circle" : "checklist").font(.title2).foregroundStyle(FinanceStyle.accent) } }
                            .frame(width: 30, height: 32)
                        Text(heading).font(.title3.bold()).accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                        Spacer(minLength: 0)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(summary).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                            if state == .saved { Text("服务器已确认，本笔记录不会重复提交。").foregroundStyle(.secondary) }
                            if state == .uncertain { Text("请确认原记录的结果。系统保留同一个提交编号，避免重复记账。").foregroundStyle(.orange) }
                            if let message, state != .ready { Text(message).font(.subheadline).foregroundStyle(.secondary) }
                        }.font(.body)
                    }.frame(maxHeight: max(100, geometry.size.height * 0.46))
                    if state == .ready {
                        Button("确认保存", action: confirm).font(.headline).frame(maxWidth: .infinity, minHeight: 50)
                            .foregroundStyle(.white).background(FinanceStyle.accent, in: RoundedRectangle(cornerRadius: 16))
                            .buttonStyle(FinancePressStyle()).disabled(busy)
                    } else if state != .failed {
                        SaveFeedbackButton(state: state, action: confirm).disabled(busy)
                    }
                    if state != .saved {
                        Button(state == .uncertain ? "稍后确认，关闭录入" : state == .failed ? "返回修改" : "返回检查", action: close)
                            .frame(minHeight: 44).disabled(busy || state == .saving)
                    }
                }.padding(22).frame(maxWidth: 480)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26))
                    .overlay { RoundedRectangle(cornerRadius: 26).strokeBorder(.white.opacity(0.15)) }
                    .shadow(color: .black.opacity(0.16), radius: 24, y: 12)
                    .padding(20).scaleEffect(appeared || reduceMotion ? 1 : 0.9).opacity(appeared ? 1 : 0)
                    .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .onAppear { withAnimation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.8)) { appeared = true }; titleFocused = true }
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: state)
                .onChange(of: state) { _, _ in titleFocused = true }
                .accessibilityAction(.escape) { if !busy && state != .saving { close() } }
        }
    }
}

private struct EntryTriggerSizeKey: PreferenceKey {
    static var defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

private struct QuickEntryModifier: ViewModifier {
    @EnvironmentObject var client: FinanceClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var entry: EntryKind?
    @State private var triggerSize = CGSize(width: 104, height: 52)
    private var disabled: Bool { client.workspace == nil || client.busy || client.pending != nil }
    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 70).allowsHitTesting(false) }
            .accessibilityHidden(expanded)
            .overlay {
                if expanded {
                    Color.black.opacity(0.18).ignoresSafeArea(edges: .bottom).contentShape(Rectangle())
                        .onTapGesture { toggle(false) }.accessibilityHidden(true).transition(.opacity)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                VStack(alignment: .trailing, spacing: 10) {
                    if expanded {
                        ScrollView {
                          VStack(spacing: 2) {
                            menuItem(.receipt, symbol: "arrow.down.left")
                            menuItem(.expense, symbol: "creditcard")
                            menuItem(.transfer, symbol: "arrow.left.arrow.right")
                            menuItem(.supplier_pay, symbol: "shippingbox")
                            Divider()
                            Button { choose(.sale_create) } label: { Label("财务及历史业务…", systemImage: "ellipsis").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 14) }
                          }.padding(6)
                        }.frame(width: 252, height: 260).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
                            .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
                            .buttonStyle(FinancePressStyle()).disabled(disabled)
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.04, anchor: UnitPoint(
                                x: 1 - triggerSize.width / (2 * 252),
                                y: 1 + (10 + triggerSize.height / 2) / 260
                            ))))
                            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
                    }
                    Button { toggle(!expanded) } label: {
                        Label(expanded ? "收起" : "记一笔", systemImage: expanded ? "xmark" : "plus")
                            .font(.headline).padding(.horizontal, 20).frame(minWidth: 104, minHeight: 52)
                            .foregroundStyle(.white).background(FinanceStyle.accent, in: Capsule())
                    }.buttonStyle(FinancePressStyle()).disabled(disabled && !expanded)
                        .accessibilityHint("展开或收回快捷记账菜单")
                        .background { GeometryReader { geometry in Color.clear.preference(key: EntryTriggerSizeKey.self, value: geometry.size) } }
                }.padding(16)
            }
            .sheet(item: $entry) { kind in EntryView(initialKind: kind) }
            .onPreferenceChange(EntryTriggerSizeKey.self) { if $0 != .zero { triggerSize = $0 } }
            .accessibilityAction(.escape) { toggle(false) }
            .onDisappear { expanded = false }
            .onChange(of: disabled) { _, value in if value { toggle(false) } }
            .sensoryFeedback(.selection, trigger: expanded)
    }
    private func toggle(_ value: Bool) { withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86)) { expanded = value } }
    private func choose(_ kind: EntryKind) { guard !disabled else { return }; toggle(false); entry = kind }
    private func menuItem(_ kind: EntryKind, symbol: String) -> some View {
        Button { choose(kind) } label: { Label(kind.title, systemImage: symbol).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 14) }
    }
}

struct WorkspaceFeedbackBanner: View {
    @EnvironmentObject var client: FinanceClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hideCompleted = false
    var body: some View {
        Group {
            if client.workspaceLoadState == .loading || client.workspaceLoadState == .failed || (client.workspaceLoadState == .loaded && !hideCompleted) {
                HStack(spacing: 10) {
                    if client.workspaceLoadState == .loading { ProgressView() }
                    else { Image(systemName: client.workspaceLoadState == .loaded ? "checkmark.circle.fill" : "exclamationmark.circle") }
                    Text(text).font(.footnote)
                    Spacer(minLength: 0)
                    if client.workspaceLoadState == .failed { Button("重试") { Task { await client.refresh() } }.disabled(client.busy).frame(minHeight: 44) }
                }.padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 40)
                    .background(.regularMaterial).transition(.opacity)
                    .accessibilityElement(children: .contain)
            }
        }.animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: client.workspaceLoadState)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: hideCompleted)
            .task(id: client.workspaceLoadState) {
                hideCompleted = false
                guard client.workspaceLoadState == .loaded else { return }
                do { try await Task.sleep(for: .seconds(2)); hideCompleted = true } catch { /* cancellation must not hide a newer request */ }
            }
    }
    private var text: String {
        switch client.workspaceLoadState {
        case .loading: return client.workspace == nil ? "正在读取账本…" : "正在更新 \(client.month)，暂显示原数据…"
        case .loaded: return "\(client.workspace?.month ?? client.month) 账本已更新"
        case .failed: return client.workspace == nil ? "账本读取失败，请重试" : "更新未完成，当前仍为原数据"
        case .idle: return ""
        }
    }
}

extension View {
    func financeEntryMenu() -> some View { modifier(QuickEntryModifier()) }
    func workspaceFeedback() -> some View { safeAreaInset(edge: .top, spacing: 0) { WorkspaceFeedbackBanner() } }
}
