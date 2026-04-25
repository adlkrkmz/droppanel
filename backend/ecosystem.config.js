module.exports = {
  apps: [
    {
      name: 'droppanel-api',
      script: 'server.ts',
      interpreter: 'ts-node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      }
    },
    {
      name: 'droppanel-worker',
      script: 'start-worker-loop.ts',
      interpreter: 'ts-node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'droppanel-panel',
      cwd: './panel',
      script: 'node',
      args: 'node_modules/next/dist/bin/next dev',
      env: {
        PORT: 3000,
        NODE_ENV: 'development'
      }
    }
  ]
}
