import SwiftUI

// App-owned interactions. These are not vendored ShipSwift components.
struct SaveFeedbackButton: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: SaveFeedbackState
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                if state == .saving { ProgressView().tint(.white) }
                else {
                    Image(systemName: state == .saved ? "checkmark.circle.fill" : state == .uncertain ? "arrow.clockwise" : state == .failed ? "exclamationmark.circle" : "checkmark.shield")
                        .accessibilityHidden(true)
                }
                Text(state.title).font(.headline).multilineTextAlignment(.center)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 15)
            .frame(minHeight: 50)
            .foregroundStyle(.white)
            .background(FinanceStyle.accent, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(FinancePressStyle())
        .disabled(state == .saving)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: state)
        .accessibilityHint(state == .saved ? "关闭本次记账，不会重复提交" : state == .uncertain ? "使用原来的记录确认结果，不会新建第二笔" : "核对明细后确认登记")
    }
}

struct FinancePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .shadow(color: .black.opacity(configuration.isPressed ? 0.02 : 0.07), radius: configuration.isPressed ? 1 : 3, y: configuration.isPressed ? 0 : 2)
            .animation(reduceMotion ? nil : .spring(response: 0.26, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

struct FinanceCheckboxStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var mixed = false
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 12) {
                Image(systemName: mixed ? "minus.square.fill" : configuration.isOn ? "checkmark.square.fill" : "square")
                    .font(.title3).foregroundStyle(configuration.isOn || mixed ? FinanceStyle.accent : .secondary)
                    .accessibilityHidden(true)
                configuration.label.foregroundStyle(.primary)
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).frame(minHeight: 48).contentShape(Rectangle())
                .background(FinanceStyle.accent.opacity(configuration.isOn || mixed ? 0.07 : 0), in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(FinanceStyle.accent.opacity(configuration.isOn || mixed ? 0.4 : 0.08)) }
        }.buttonStyle(FinancePressStyle())
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: configuration.isOn)
            .accessibilityElement(children: .combine)
            .accessibilityValue(mixed ? "部分勾选" : configuration.isOn ? "已勾选" : "未勾选")
    }
}

struct AccountCardStack: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var cardHeight: CGFloat = 186
    @ScaledMetric(relativeTo: .body) private var foldedStep: CGFloat = 34
    @State private var expanded = false
    let accounts: [Account]
    let selectedIDs: Set<String>
    let toggle: (String) -> Void
    let detailAccountID: String?
    let openDetails: (String) -> Void
    private var stackHeight: CGFloat {
        accounts.isEmpty ? 0 : cardHeight + CGFloat(accounts.count - 1) * (expanded ? cardHeight + 12 : foldedStep)
    }
    var body: some View {
        VStack(spacing: 12) {
            Button(action: toggleExpanded) {
                HStack {
                    Label("全部账户 · \(accounts.count)", systemImage: "square.stack.3d.up")
                    Spacer(minLength: 8)
                    Text(expanded ? "收起" : "展开").font(.subheadline)
                    Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0))
                }.font(.headline).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(FinancePressStyle())
                .accessibilityLabel(expanded ? "收起全部账户卡片" : "展开全部账户卡片")
                .accessibilityValue(expanded ? "已展开" : "已叠放")
            ZStack(alignment: .top) {
                ForEach(Array(accounts.enumerated()), id: \.element.id) { index, account in
                    accountCard(account, index: index)
                        .frame(height: cardHeight)
                        .padding(.horizontal, expanded ? 0 : CGFloat(min(accounts.count - 1 - index, 5)) * 3)
                        .offset(y: CGFloat(index) * (expanded ? cardHeight + 12 : foldedStep))
                        .zIndex(Double(index))
                        .animation(cardAnimation(index), value: expanded)
                }
            }
            .frame(height: stackHeight, alignment: .top)
            .animation(reduceMotion ? nil : .spring(response: 0.46, dampingFraction: 0.88), value: expanded)
            .overlay {
                if !expanded {
                    Button(action: toggleExpanded) { Color.clear.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("展开 \(accounts.count) 个账户")
                        .accessibilityHint("账户将按顺序展开，之后可以勾选账户或查看详情")
                }
            }
            if expanded && accounts.count > 2 {
                Button(action: toggleExpanded) { Label("收起全部账户", systemImage: "square.stack.3d.up").frame(minHeight: 44) }
                    .buttonStyle(FinancePressStyle())
            }
        }.padding(.vertical, 6)
            .sensoryFeedback(.selection, trigger: expanded)
            .sensoryFeedback(.selection, trigger: selectedIDs)
    }
    private func cardAnimation(_ index: Int) -> Animation? {
        guard !reduceMotion else { return nil }
        let order = expanded ? index : accounts.count - 1 - index
        return .spring(response: 0.44, dampingFraction: 0.86).delay(min(Double(order) * 0.045, 0.28))
    }
    private func toggleExpanded() { expanded.toggle() }
    private func accountCard(_ account: Account, index: Int) -> some View {
        let selected = selectedIDs.contains(account.id)
        let tint: Color = [FinanceStyle.accent, .blue, .cyan, .indigo][index % 4]
        return VStack(alignment: .leading, spacing: 0) {
            Button(action: toggleExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(account.name).font(.headline).lineLimit(1)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.up").font(.caption).opacity(expanded ? 1 : 0)
                    }
                    if expanded { Text(account.typeLabel).font(.caption).foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    MoneyText(amount: account.balance).font(.title2.bold())
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("\(account.name)，余额 \(Money.display(account.balance))，收起全部账户")
            HStack(spacing: 16) {
                Button { toggle(account.id) } label: {
                    Label(selected ? "已计入筛选" : "勾选账户", systemImage: selected ? "checkmark.circle.fill" : "circle")
                        .font(.caption.bold()).frame(minHeight: 44)
                }.buttonStyle(FinancePressStyle())
                    .accessibilityLabel("筛选\(account.name)").accessibilityValue(selected ? "已勾选" : "未勾选")
                Spacer(minLength: 0)
                Button { openDetails(account.id) } label: {
                    Label("详情", systemImage: "arrow.up.left.and.arrow.down.right").font(.caption.bold()).frame(minHeight: 44)
                }.buttonStyle(FinancePressStyle()).accessibilityLabel("查看\(account.name)详情")
            }.foregroundStyle(tint)
        }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 6)
            .foregroundStyle(.primary)
            .background {
                RoundedRectangle(cornerRadius: 20).fill(.background)
                RoundedRectangle(cornerRadius: 20).fill(tint.opacity(selected ? 0.13 : 0.055))
            }
            .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(tint.opacity(selected ? 0.7 : 0.2), lineWidth: selected ? 1.5 : 1) }
            .shadow(color: .black.opacity(expanded ? 0.06 : 0.09), radius: expanded ? 6 : 3, y: expanded ? 3 : -1)
            .anchorPreference(key: AccountBoundsKey.self, value: .bounds) { [account.id: $0] }
            .opacity(detailAccountID == account.id ? 0 : 1)
            .accessibilityHidden(!expanded)
            .allowsHitTesting(expanded)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: selected)
    }
}

struct ProfitCardStack: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    let report: Report
    var isDaily = false
    var body: some View {
        VStack(spacing: 12) {
            Button(action: toggleExpanded) {
                HStack {
                    Label("利润构成", systemImage: "square.stack.3d.up")
                    Spacer()
                    Text(expanded ? "收起" : "展开").font(.subheadline)
                    Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0))
                }.font(.headline).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityValue(expanded ? "已展开" : "已收起")
            if expanded {
                profitCard(title: "销售与退货", symbol: "shippingbox", rows: [
                    ("回款确认毛利", report.salesProfit), ("退货冲回", report.returnReversal)
                ])
                profitCard(title: "经营支出", symbol: "creditcard", rows: [
                    (isDaily ? "当日已付费用" : "当月已付费用", report.expenses), (isDaily ? (report.taxEstimated == true ? "日均税费（暂估）" : "日均税费") : "手填月度税费", report.tax)
                ])
                profitCard(title: "调整与结果", symbol: "equal.circle", rows: [
                    (isDaily ? "当日调整" : "当月调整", report.adjustments), (isDaily ? "日利润" : "月利润", report.profit)
                ])
            } else {
                Button(action: toggleExpanded) {
                    VStack(alignment: .leading, spacing: 10) {
                    Text(isDaily ? "日利润" : "月利润").font(.subheadline).foregroundStyle(.secondary)
                    MoneyText(amount: report.profit).font(.title2.bold())
                    Text("展开查看销售、支出和调整").font(.caption).foregroundStyle(.secondary)
                }
                .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                .background(.background, in: RoundedRectangle(cornerRadius: 18))
                .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(FinanceStyle.accent.opacity(0.18)) }
                .background {
                    RoundedRectangle(cornerRadius: 18).fill(FinanceStyle.accent.opacity(0.13)).padding(.horizontal, 10).offset(y: 8)
                        .background { RoundedRectangle(cornerRadius: 18).fill(FinanceStyle.accent.opacity(0.06)).padding(.horizontal, 20).offset(y: 16) }
                    }.padding(.bottom, 16)
                }.buttonStyle(FinancePressStyle())
                    .accessibilityHint("展开三张利润明细卡片")
            }
        }.sensoryFeedback(.selection, trigger: expanded)
    }
    private func toggleExpanded() {
        withAnimation(reduceMotion ? nil : .spring(response: 0.4, dampingFraction: 0.86)) { expanded.toggle() }
    }
    private func profitCard(title: String, symbol: String, rows: [(String, Int64)]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol).font(.headline).foregroundStyle(FinanceStyle.accent)
            ForEach(rows, id: \.0) { row in AmountRow(title: row.0, amount: row.1).font(.subheadline) }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(FinanceStyle.accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 18))
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
    }
}

struct MonthWheelSheet: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @Environment(\.dismiss) private var dismiss
    @State private var year: Int
    @State private var month: Int
    private let years: ClosedRange<Int>
    let apply: (String) -> Void
    init(current: String, apply: @escaping (String) -> Void) {
        let value = ReportMonth(current) ?? ReportMonth(BusinessDate.string(month: true))!
        _year = State(initialValue: value.year); _month = State(initialValue: value.month)
        years = min(1900, value.year)...max(2100, value.year)
        self.apply = apply
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("选择利润统计月份").font(.headline)
                HStack(spacing: 0) {
                    Picker("年份", selection: $year) { ForEach(years, id: \.self) { Text(String($0) + "年").tag($0) } }
                    Picker("月份", selection: $month) { ForEach(1...12, id: \.self) { Text("\($0)月").tag($0) } }
                }
                #if os(iOS)
                .pickerStyle(.wheel)
                #endif
                Text("点击确定后更新报表").font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }.padding()
                .navigationTitle("统计月份")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("确定") { if let value = ReportMonth(year: year, month: month) { apply(value.value); dismiss() } }
                    }
                }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}

struct TransferRouteView: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    let from: Account?
    let to: Account?
    var body: some View {
        VStack(spacing: 0) {
            endpoint(title: "转出", account: from, symbol: "arrow.up.right")
            if let from, let to, from.id != to.id {
                TransferConnector().id(from.id + ":" + to.id).frame(height: 50)
            } else {
                Text(from?.id == to?.id && from != nil ? "请选择不同的转入账户" : "选择两端账户后显示转账方向")
                    .font(.caption).foregroundStyle(.secondary).frame(minHeight: 50)
            }
            endpoint(title: "转入", account: to, symbol: "arrow.down.left")
        }.accessibilityElement(children: .combine)
    }
    private func endpoint(title: String, account: Account?, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(FinanceStyle.accent).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(account?.name ?? "待选择").font(.headline)
            }
            Spacer(minLength: 0)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(FinanceStyle.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct TransferConnector: View {
    @ObservedObject private var amountPreferences = AppPreferences.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawn = false
    var body: some View {
        GeometryReader { geometry in
            let x = geometry.size.width / 2
            Path { path in
                path.move(to: CGPoint(x: x, y: 5)); path.addLine(to: CGPoint(x: x, y: 40))
                path.move(to: CGPoint(x: x - 6, y: 34)); path.addLine(to: CGPoint(x: x, y: 40)); path.addLine(to: CGPoint(x: x + 6, y: 34))
            }
            .trim(from: 0, to: drawn ? 1 : 0)
            .stroke(FinanceStyle.accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
        }.accessibilityHidden(true)
            .onAppear { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.35)) { drawn = true } }
    }
}
