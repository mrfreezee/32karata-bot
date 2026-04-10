const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
});

async function saveClientToDB(userId, clientData, phone) {
    const query = `
        INSERT INTO clients (
            user_id, full_name, phone, birth_date, reg_date, role, 
            clinic_person_id, is_new
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, 'пациент', $5, false)
        ON CONFLICT (user_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            birth_date = EXCLUDED.birth_date,
            clinic_person_id = EXCLUDED.clinic_person_id
        RETURNING *;
    `;

    const values = [
        userId,
        clientData.display_name || null,
        phone,
        clientData.birthday || null,
        clientData.id_client || null
    ];

    try {
        const result = await pool.query(query, values);
        console.log(new Date().toISOString(), 'Клиент сохранен в БД:', userId);
        return result.rows[0];
    } catch (error) {
        console.error('Ошибка сохранения клиента:', error);
        return null;
    }
}

async function updateClientIsNew(userId) {
    await pool.query(
        `UPDATE clients SET is_new = false WHERE user_id = $1`,
        [userId]
    );
}

module.exports = { pool, saveClientToDB, updateClientIsNew };