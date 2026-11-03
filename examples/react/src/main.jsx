import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { init } from '@replayd/core';
import { ErrorBoundary, reactErrorHandler } from '@replayd/react';

init({ dsn: import.meta.env.VITE_REPLAYD_DSN, release: 'react-1.0.0', environment: 'example' });

function OrderPanel({ order }) {
  return <p>{order.price.toFixed(2)}</p>;
}
function App() {
  const [show, setShow] = useState(false);
  return (
    <>
      <h1>React 19</h1>
      <button id="buy" onClick={() => setShow(true)}>Buy</button>
      <ErrorBoundary fallback={<p id="fallback">Order panel failed</p>}>{show && <OrderPanel order={{}} />}</ErrorBoundary>
    </>
  );
}
// React 19 root options: errors outside boundaries too (the boundary's error is reported once: core dedups)
createRoot(document.getElementById('root'), { onUncaughtError: reactErrorHandler(), onCaughtError: reactErrorHandler() }).render(<App />);
