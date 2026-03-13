// PM2 Ecosystem Config — LandlordHQ
// Usage:
//   First time:  pm2 start ecosystem.config.js
//   Update:      pm2 reload ecosystem.config.js --update-env
//   Save state:  pm2 save
//   Auto-start:  pm2 startup  (then run the command it prints)

module.exports = {
  apps: [
    {
      name: 'landlordhq-server',
      script: 'src/server.js',
      cwd: '/var/www/landlordhq',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/landlordhq/server-error.log',
      out_file:   '/var/log/landlordhq/server-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'landlordhq-bot',
      script: 'src/bot.js',
      cwd: '/var/www/landlordhq',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/landlordhq/bot-error.log',
      out_file:   '/var/log/landlordhq/bot-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
