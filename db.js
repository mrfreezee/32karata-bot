const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
});

const medCorePool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.MEDCOREDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
})

async function updateClientIsNew(userId) {
    await pool.query(
        `UPDATE clients SET is_new = false WHERE user_id = $1`,
        [userId]
    );
}

module.exports = { pool, medCorePool, updateClientIsNew };