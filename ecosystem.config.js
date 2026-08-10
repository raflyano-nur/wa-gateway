module.exports = {
  apps: [
    {
      name: "wa-gateway",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
