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
    }
};