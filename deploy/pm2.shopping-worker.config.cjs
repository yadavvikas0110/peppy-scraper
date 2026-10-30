/**
 * PM2 process file for the Amazon UAE shopping worker. Template — review before use.
 *
 *   npm ci && npm run build
 *   pm2 start deploy/pm2.shopping-worker.config.cjs      # start
 *   pm2 save && pm2 startup systemd                      # restart after reboot (run the printed command)
 *   pm2 logs peppy-shopping-worker                       # live logs
 *   npm run shopping:worker:status                       # jobs, schedule, budget, failures
 *   pm2 stop peppy-shopping-worker                       # graceful stop (SIGINT → checkpoint → exit)
 */
module.exports = {
  apps: [
    {
      name: 'peppy-shopping-worker',
      cwd: __dirname + '/..',
      script: 'dist/src/worker/worker.cli.js',
      args: 'start',
      // Point at the env file for this server (dev: .env.dev). Keep ENABLE_CRON=false in it.
      node_args: '--env-file=.env.dev',
      instances: 1,              // the Mongo scheduler lock also prevents a second worker
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 30000,      // a crash-looping worker must not burn the request budget
      max_restarts: 20,
      min_uptime: 60000,
      kill_timeout: 120000,      // time to finish the current product and checkpoint on stop
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production' },
      out_file: 'output/logs/pm2-shopping-worker.out.log',
      error_file: 'output/logs/pm2-shopping-worker.err.log',
      time: true,
    },
  ],
};
