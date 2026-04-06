// config.js
require('dotenv').config();

module.exports = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    DB: {
        user: 'postgres',
        host: 'localhost',
        database: '32karata',
        password: '5600119kj;rf',
        port: 5433,
    },
    API: {
        TOKEN: 'ff66ef3e-0ffb-49b5-a7c7-2b7659ae2a1e',
        SECRET: '9e27bda7406bf9f79154dbd8fc5d3a8c',
        CLIENT_URL: 'https://32karatatlt.dental-pro.online/api/client_by_phone',
        SCHEDULE_URL: 'https://32karatatlt.dental-pro.online/api/mobile/schedule',
    }
};