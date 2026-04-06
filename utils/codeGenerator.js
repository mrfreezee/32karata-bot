const { pool } = require('../db');

async function generateUniqueCode() {
    let code;
    let exists = true;

    while (exists) {
        code = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await pool.query(
            `SELECT user_id FROM public.client WHERE client_code = $1 OR ref_code = $1`,
            [code]
        );
        exists = result.rows.length > 0;
    }

    return code;
}

module.exports = { generateUniqueCode };