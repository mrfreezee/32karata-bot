// keyboards/keyboards.js
const { Keyboard } = require('@maxhub/max-bot-api');

// Клавиатура с кнопкой запроса контакта
const requestContactKeyboard = Keyboard.inlineKeyboard([
    [
        Keyboard.button.requestContact('📞 Отправить номер телефона')
    ]
]);

// Клавиатура для подтверждения данных
const confirmKeyboard = Keyboard.inlineKeyboard([
    [
        Keyboard.button.callback('✅ Да, это мои данные', 'confirm_data'),
        Keyboard.button.callback('❌ Нет, отменить', 'cancel_auth')
    ]
]);

// Клавиатура для согласия на обработку данных
const agreeKeyboard = Keyboard.inlineKeyboard([
    [
        Keyboard.button.callback('✅ Согласен', 'agree_processing'),
        Keyboard.button.callback('❌ Не согласен', 'cancel_auth')
    ]
]);

module.exports = { requestContactKeyboard, confirmKeyboard, agreeKeyboard };