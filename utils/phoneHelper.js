function cleanPhoneNumber(phone) {
    let cleaned = String(phone).replace(/[^\d]/g, '');
    if (cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.slice(1);
    }
    return cleaned;
}

module.exports = { cleanPhoneNumber };