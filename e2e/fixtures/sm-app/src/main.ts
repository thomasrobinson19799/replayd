import { placeOrder } from './order';

document.getElementById('buy')!.addEventListener('click', () => {
  placeOrder({ symbol: 'EURUSD' });
});
