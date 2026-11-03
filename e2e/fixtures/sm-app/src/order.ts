// e2e fixture (T-30): the error must symbolicate to this file, line 4
export interface Order { symbol: string; price?: number }
export function placeOrder(order: Order): string {
  return order.price!.toFixed(5) + ' ' + order.symbol;
}
