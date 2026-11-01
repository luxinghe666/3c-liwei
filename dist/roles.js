// Role labels and navigation hints; the server independently authorizes every request.
export const roleNames = Object.freeze({owner:'老板',finance:'财务',procurement_sales:'采销',warehouse:'出库入库'});
export const roleName = role => Object.hasOwn(roleNames,role) ? roleNames[role] : '未知岗位';
export const isStockRole = role => ['procurement_sales','warehouse'].includes(role);
export const isFinanceRole = role => ['owner','finance'].includes(role);
