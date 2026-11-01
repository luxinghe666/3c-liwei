import SwiftUI

struct AccountBoundsKey: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newer in newer })
    }
}

// The origin is resolved from the visible card's anchor, not a guessed screen
// coordinate. Keeping its source in the scroll view preserves the return path.
struct AccountDetailPanel: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var headingFocused: Bool
    let account: Account
    let transactions: [Transaction]
    let origin: CGRect
    let container: CGSize
    let dismiss: () -> Void
    @State private var expanded = false
    @State private var closing = false
    private var animation: Animation? { reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.88) }
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.opacity(expanded ? 0.28 : 0).ignoresSafeArea()
                .onTapGesture(perform: close).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(account.name).font(.title3.bold()).accessibilityAddTraits(.isHeader).accessibilityFocused($headingFocused)
                        if expanded { Text(account.typeLabel).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength: 4)
                    if expanded { Button(action: close) { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("关闭账户详情") }
                }
                MoneyText(amount: account.balance).font(.title.bold())
                if expanded {
                    Text("当前余额 · 最近 10 笔流水").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if transactions.isEmpty { Text("该账户暂无流水").foregroundStyle(.secondary).padding(.vertical) }
                            ForEach(transactions) { row in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack { Text(transactionTitle(row.type)); Spacer(minLength: 8); MoneyText(amount: row.amount).foregroundStyle(row.amount > 0 ? FinanceStyle.accent : .primary) }
                                    Text(row.date).font(.caption).foregroundStyle(.secondary)
                                    if !row.note.isEmpty { Text(row.note).font(.subheadline).foregroundStyle(.secondary) }
                                }.accessibilityElement(children: .combine)
                                Divider()
                            }
                        }
                    }
                    Text("查看详情不改变账户勾选和账本。").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.padding(20)
                .frame(width: expanded ? min(520, max(120, container.width - 32)) : origin.width,
                       height: expanded ? max(180, min(640, container.height - 32)) : origin.height,
                       alignment: .topLeading)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: expanded ? 26 : 20))
                .overlay { RoundedRectangle(cornerRadius: expanded ? 26 : 20).strokeBorder(FinanceStyle.accent.opacity(0.18)) }
                .clipShape(RoundedRectangle(cornerRadius: expanded ? 26 : 20))
                .shadow(color: .black.opacity(expanded ? 0.18 : 0), radius: 24, y: 12)
                .position(x: expanded ? container.width / 2 : origin.midX, y: expanded ? container.height / 2 : origin.midY)
                .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        }.onAppear { withAnimation(animation) { expanded = true }; headingFocused = true }
            .accessibilityAction(.escape, close)
    }
    private func close() {
        guard !closing else { return }; closing = true
        withAnimation(animation, completionCriteria: .logicallyComplete) { expanded = false } completion: { dismiss() }
    }
}
