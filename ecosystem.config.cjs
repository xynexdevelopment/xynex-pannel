module.exports = {
  apps: [
    {
      name: "xynex-panel",
      cwd: __dirname, // always run from the panel folder so .data/ is never recreated elsewhere
      script: "npm",
      args: "start",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      // Don't crash-loop: wait between restarts and give up after repeated early exits.
      // Never give up: back off 1s -> 15s between tries, forever (healthcheck.sh also revives it).
      exp_backoff_restart_delay: 1000,
      min_uptime: "10s",
      max_restarts: 100000,
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 6767
      }
    }
  ]
};
