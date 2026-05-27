// services/reviewService.js
const { pool, medCorePool } = require('../db');
const logger = require('./loggerService');

// Исключаем эти специальности из запросов отзывов
const EXCLUDED_SPECIALTIES = [
    'рентген',
    'Рентген',
    'РЕНТГЕН',
    'рентген лаборант',
    'Рентген Лаборант',
    'РЕНТГЕН ЛАБОРАНТ',
    'анестезиолог',
    'Анестезиологи',
    'анестезия',
    'Анестезия',
    'наркоз',
    'Наркоз'
];

// Проверка, нужно ли пропустить врача
function shouldSkipDoctor(doctorTitle, doctorSubtitle, doctorTooltip) {
    const textToCheck = `${doctorTitle || ''} ${doctorSubtitle || ''} ${doctorTooltip || ''}`.toLowerCase();
    
    return EXCLUDED_SPECIALTIES.some(excluded => 
        textToCheck.includes(excluded.toLowerCase())
    );
}

// Сохранение запроса на отзыв (pending)
async function savePendingReview(patientId, doctorId, doctorName, appointmentDate, branchId, chatId) {
    try {
        const query = `
            INSERT INTO pending_reviews (patient_id, doctor_id, doctor_name, appointment_date, branch_id, chat_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (patient_id, doctor_id, appointment_date) DO NOTHING
            RETURNING id
        `;
        const result = await medCorePool.query(query, [patientId, doctorId, doctorName, appointmentDate, branchId, chatId]);
        
        if (result.rows.length > 0) {
            logger.info(`Сохранен pending review: patient=${patientId}, doctor=${doctorId}`);
        }
        return result.rows[0]?.id;
    } catch (error) {
        logger.error(error, { function: 'savePendingReview', patientId, doctorId });
        throw error;
    }
}

// Сохранение оценки (звезды) - убираем ON CONFLICT
async function saveReview(patientId, doctorId, stars, appointmentDate, branchId = null, tgId = null) {
    try {
        console.log(`💾 saveReview: patient=${patientId}, doctor=${doctorId}, stars=${stars}, tgId=${tgId}`);
        
        // Получаем doctor_name из pending_reviews или из врача
        let doctorName = null;
        const pendingResult = await medCorePool.query(
            `SELECT doctor_name FROM pending_reviews 
             WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
        
        if (pendingResult.rows.length > 0) {
            doctorName = pendingResult.rows[0].doctor_name;
        }
        
        // Проверяем, существует ли уже отзыв
        const existingResult = await medCorePool.query(
            `SELECT id FROM reviews WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
        
        let result;
        if (existingResult.rows.length > 0) {
            // Обновляем существующий отзыв
            result = await medCorePool.query(
                `UPDATE reviews 
                 SET stars = $1, 
                     updated_at = NOW(),
                     tg_id = COALESCE($2, tg_id)
                 WHERE patient_id = $3 AND doctor_id = $4 AND appointment_date = $5
                 RETURNING id`,
                [stars, tgId, patientId, doctorId, appointmentDate]
            );
        } else {
            // Вставляем новый отзыв с tg_id
            result = await medCorePool.query(
                `INSERT INTO reviews (patient_id, doctor_id, doctor_name, stars, appointment_date, branch_id, tg_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                 RETURNING id`,
                [patientId, doctorId, doctorName, stars, appointmentDate, branchId, tgId]
            );
        }
        
        // Удаляем из pending_reviews
        await medCorePool.query(
            `DELETE FROM pending_reviews WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
        
        console.log(`✅ Сохранен review: id=${result.rows[0].id}, tg_id=${tgId}`);
        logger.info(`Сохранен review: patient=${patientId}, doctor=${doctorId}, stars=${stars}, tg_id=${tgId}`);
        return result.rows[0].id;
    } catch (error) {
        console.error('❌ Ошибка в saveReview:', error);
        logger.error(error, { function: 'saveReview', patientId, doctorId, stars });
        throw error;
    }
}

// Сохранение текстового отзыва
async function saveReviewText(patientId, doctorId, appointmentDate, reviewText) {
    try {
        console.log(`💾 saveReviewText: patient=${patientId}, doctor=${doctorId}, text="${reviewText}"`);
        
        const query = `
            UPDATE reviews 
            SET review_text = $1, 
                review_text_received_at = NOW(),
                waiting_for_text = false
            WHERE patient_id = $2 AND doctor_id = $3 AND appointment_date = $4
            RETURNING id
        `;
        const result = await medCorePool.query(query, [reviewText, patientId, doctorId, appointmentDate]);
        
        if (result.rows.length === 0) {
            console.log(`⚠️ Не найдена запись для обновления: patient=${patientId}, doctor=${doctorId}`);
            // Попробуем найти запись
            const checkResult = await medCorePool.query(
                `SELECT id, waiting_for_text FROM reviews WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
                [patientId, doctorId, appointmentDate]
            );
            console.log(`📊 Найдено записей: ${checkResult.rows.length}`, checkResult.rows[0]);
        }
        
        logger.info(`Сохранен текст отзыва: patient=${patientId}, doctor=${doctorId}`);
        return result.rows[0]?.id;
    } catch (error) {
        console.error('❌ Ошибка в saveReviewText:', error);
        logger.error(error, { function: 'saveReviewText', patientId, doctorId });
        throw error;
    }
}

// Получение количества отзывов пациента (для определения первого)
async function getPatientReviewsCount(patientId) {
    try {
        const result = await medCorePool.query(
            `SELECT COUNT(*) as count FROM reviews WHERE patient_id = $1`,
            [patientId]
        );
        return parseInt(result.rows[0].count);
    } catch (error) {
        logger.error(error, { function: 'getPatientReviewsCount', patientId });
        return 0;
    }
}

// Получение информации о pending review
async function getPendingReview(patientId, doctorId, appointmentDate) {
    try {
        const result = await medCorePool.query(
            `SELECT * FROM pending_reviews 
             WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
        return result.rows[0] || null;
    } catch (error) {
        logger.error(error, { function: 'getPendingReview', patientId, doctorId });
        return null;
    }
}

// Проверка, существует ли уже отзыв
async function reviewExists(patientId, doctorId, appointmentDate) {
    try {
        const result = await medCorePool.query(
            `SELECT id FROM reviews WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
        return result.rows.length > 0;
    } catch (error) {
        logger.error(error, { function: 'reviewExists', patientId, doctorId });
        return false;
    }
}

// Установка флага ожидания текстового отзыва
async function setWaitingForText(patientId, doctorId, appointmentDate, nextAction = null) {
    try {
        await medCorePool.query(
            `UPDATE reviews 
             SET waiting_for_text = true, 
                 next_action = $1,
                 waiting_for_text_started_at = NOW()
             WHERE patient_id = $2 AND doctor_id = $3 AND appointment_date = $4`,
            [nextAction, patientId, doctorId, appointmentDate]
        );
        logger.info(`Установлен waiting_for_text: patient=${patientId}, doctor=${doctorId}, nextAction=${nextAction}`);
    } catch (error) {
        logger.error(error, { function: 'setWaitingForText', patientId, doctorId });
        throw error;
    }
}

// Обновление next_action после отправки
async function updateNextAction(patientId, doctorId, appointmentDate, nextAction) {
    try {
        await medCorePool.query(
            `UPDATE reviews 
             SET next_action = $1
             WHERE patient_id = $2 AND doctor_id = $3 AND appointment_date = $4`,
            [nextAction, patientId, doctorId, appointmentDate]
        );
    } catch (error) {
        logger.error(error, { function: 'updateNextAction', patientId, doctorId });
        throw error;
    }
}

// Получение ожидающего текстового отзыва
async function getWaitingForText(userId) {
    try {
        console.log(`🔍 getWaitingForText: поиск для userId=${userId}`);
        
       const result = await medCorePool.query(
    `SELECT id, patient_id, doctor_id, appointment_date, next_action, waiting_for_text, branch_id
     FROM reviews 
     WHERE tg_id = $1 AND waiting_for_text = true
     LIMIT 1`,
    [userId]
);
        
        console.log(`📊 Результат: ${result.rows.length} записей`);
        if (result.rows.length > 0) {
            console.log(`   ✅ Найден отзыв для patient_id=${result.rows[0].patient_id}`);
        }
        
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Ошибка в getWaitingForText:', error);
        return null;
    }
}

// Сброс waiting_for_text
async function clearWaitingForText(patientId, doctorId, appointmentDate) {
    try {
        await medCorePool.query(
            `UPDATE reviews 
             SET waiting_for_text = false, next_action = NULL
             WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
            [patientId, doctorId, appointmentDate]
        );
    } catch (error) {
        logger.error(error, { function: 'clearWaitingForText', patientId, doctorId });
        throw error;
    }
}

module.exports = {
    EXCLUDED_SPECIALTIES,
    shouldSkipDoctor,
    savePendingReview,
    saveReview,
    saveReviewText,
    getPatientReviewsCount,
    getPendingReview,
    reviewExists,
    setWaitingForText,
    updateNextAction,
    getWaitingForText,
    clearWaitingForText
};