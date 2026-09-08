import('./src/app.js').catch((error) => {
  console.error('Failed to start Father-Time:', error);
  process.exit(1);
});