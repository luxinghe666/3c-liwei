import SwiftUI

struct OpeningItem:Identifiable {let id=UUID();var productId="";var supplierId="";var customerId="";var qty="1";var cost="";var amount="";var freight="0";var paid="0";var date=Date()}
struct OpeningView:View {
    @EnvironmentObject var client:FinanceClient
    @State private var date=Date()
    @State private var balances:[String:String]=[:]
    @State private var credits:[String:String]=[:]
    @State private var prepaid:[String:String]=[:]
    @State private var payable:[String:String]=[:]
    @State private var boss="0"
    @State private var stocks:[OpeningItem]=[]
    @State private var sales:[OpeningItem]=[]
    @State private var editor:String?
    @State private var confirmed=false
    private func bind(_ key:String,_ values:Binding<[String:String]>)->Binding<String>{Binding(get:{values.wrappedValue[key] ?? "0"},set:{values.wrappedValue[key]=$0})}
    var body:some View {Form{
        if let opening=client.workspace?.state.opening {Section{Label("已完成期初建档",systemImage:"checkmark.circle");Text(opening.date+" · "+opening.confirmedBy)}}
        else if client.user?.role != "owner" {Text("请由老板确认期初建档。")}
        else if let book=client.workspace?.state {
            Section {Text("先建立账户、客户、供应商及商品，再填写期初。仅空白账本可确认；期初金额不计本期利润。所有金额单位为元。").font(.footnote);DatePicker("启用日",selection:$date,displayedComponents:.date);TextField("期初公司欠老板",text:$boss).decimalEntry()}
            Section("账户实际余额"){ForEach(book.accounts){a in TextField(a.name,text:bind(a.id,$balances)).decimalEntry()}}
            Section("期初在库商品"){ForEach(stocks){r in HStack{VStack(alignment:.leading){Text(book.product(r.productId));Text("数量 "+r.qty).font(.caption)};Spacer();Button("移除",role:.destructive){stocks.removeAll{$0.id==r.id}}}};Button("增加在库商品"){editor="stock"}}
            Section("期初未结销售"){ForEach(sales){r in HStack{VStack(alignment:.leading){Text(book.customer(r.customerId)+" · "+book.product(r.productId));Text("数量 "+r.qty).font(.caption)};Spacer();Button("移除",role:.destructive){sales.removeAll{$0.id==r.id}}}};Button("增加未结销售"){editor="sale"};Text("填写原销售成本和启用日前已收金额；只将后续新增回款计入利润。").font(.footnote).foregroundStyle(.secondary)}
            Section("客户期初可用余额"){ForEach(book.customers){c in TextField(c.name,text:bind(c.id,$credits)).decimalEntry()}}
            Section("供应商期初余额"){ForEach(book.suppliers){s in VStack(alignment:.leading){Text(s.name).font(.headline);TextField("预付款余额",text:bind(s.id,$prepaid)).decimalEntry();TextField("待付货款",text:bind(s.id,$payable)).decimalEntry()}}}
            Section {Toggle("已核对全部期初资料",isOn:$confirmed);Button("确认期初建档"){Task{await submit(book)}}.disabled(!confirmed||client.busy||client.pending != nil)}
        }
    }.navigationTitle("期初建档").sheet(isPresented:Binding(get:{editor != nil},set:{if !$0{editor=nil}})){OpeningItemEditor(isSale:editor=="sale"){item in if editor=="sale"{sales.append(item)}else{stocks.append(item)};editor=nil}}
    .onAppear{if balances.isEmpty{for a in client.workspace?.state.accounts ?? []{balances[a.id]=NSDecimalNumber(value:a.balance).dividing(by:100).stringValue}}}}
    private func submit(_ book:Book) async {do{
        let inventory=try stocks.map{try json($0,isSale:false)},unsettled=try sales.map{try json($0,isSale:true)}
        let a:[String:JSONValue]=["type":.string("opening_set"),"date":.string(BusinessDate.string(date)),"bossOwed":.integer(try Money.cents(boss,allowZero:true)),
            "accounts":.array(try book.accounts.map{.object(["accountId":.string($0.id),"balance":.integer(try Money.cents(balances[$0.id] ?? "0",allowZero:true))])}),
            "inventory":.array(inventory),"sales":.array(unsettled),
            "customers":.array(try book.customers.map{.object(["customerId":.string($0.id),"credit":.integer(try Money.cents(credits[$0.id] ?? "0",allowZero:true))])}),
            "suppliers":.array(try book.suppliers.map{.object(["supplierId":.string($0.id),"prepaid":.integer(try Money.cents(prepaid[$0.id] ?? "0",allowZero:true)),"payable":.integer(try Money.cents(payable[$0.id] ?? "0",allowZero:true))])})]
        _ = await client.submit(a)
    }catch{client.message=error.localizedDescription}}
    private func json(_ r:OpeningItem,isSale:Bool)throws->JSONValue {
        guard let qty=Int64(r.qty),(1...1000).contains(qty) else{throw InputError.invalid("数量须为 1–1000 的整数")}
        var data:[String:JSONValue]=["qty":.integer(qty),"productId":.string(r.productId),"supplierId":.string(r.supplierId),"cost":.integer(try Money.cents(r.cost,allowZero:true))]
        if isSale{data["customerId"] = .string(r.customerId);data["saleDate"] = .string(BusinessDate.string(r.date));data["amount"] = .integer(try Money.cents(r.amount));data["freight"] = .integer(try Money.cents(r.freight,allowZero:true));data["paid"] = .integer(try Money.cents(r.paid,allowZero:true))};return .object(data)
    }
}
struct OpeningItemEditor:View {
    @EnvironmentObject var client:FinanceClient
    @Environment(\.dismiss) private var dismiss
    let isSale:Bool;let add:(OpeningItem)->Void
    @State private var draft=OpeningItem()
    var body:some View {NavigationStack{Form{if let book=client.workspace?.state{
        Picker("商品",selection:$draft.productId){Text("请选择").tag("");ForEach(book.products){Text($0.name).tag($0.id)}}
        Picker("供应商",selection:$draft.supplierId){Text("来源待补").tag("");ForEach(book.suppliers){Text($0.name).tag($0.id)}}
        TextField("数量",text:$draft.qty).numberEntry()
        TextField(isSale ? "原销售总成本（含进货运费）":"单件到货成本（含进货运费）",text:$draft.cost).decimalEntry()
        if isSale{Picker("客户",selection:$draft.customerId){Text("请选择").tag("");ForEach(book.customers){Text($0.name).tag($0.id)}};DatePicker("原销售日期",selection:$draft.date,displayedComponents:.date);TextField("原销售金额",text:$draft.amount).decimalEntry();TextField("原销售运费",text:$draft.freight).decimalEntry();TextField("启用前已收金额",text:$draft.paid).decimalEntry()}
        Button("加入期初清单"){do{_ = try Money.cents(draft.cost,allowZero:true);if isSale{let total=try Money.cents(draft.amount);let paid=try Money.cents(draft.paid,allowZero:true);_ = try Money.cents(draft.freight,allowZero:true);guard paid<total else{throw InputError.invalid("已收金额必须小于销售总额")}};guard let qty=Int(draft.qty),(1...1000).contains(qty) else{throw InputError.invalid("数量须为 1–1000 的整数")};add(draft);dismiss()}catch{client.message=error.localizedDescription}}.disabled(draft.productId.isEmpty||draft.qty.isEmpty||draft.cost.isEmpty||(isSale&&draft.customerId.isEmpty))
    }}.navigationTitle(isSale ? "期初未结销售":"期初在库商品").toolbar{Button("取消"){dismiss()}}}}
}
