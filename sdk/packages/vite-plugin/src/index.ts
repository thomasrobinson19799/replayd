/** @replayd/vite-plugin — upload source maps after build. Implemented in T-30. */
export default function replaydSourcemaps(): { name: string } {
  return { name: 'replayd-sourcemaps' };
}
