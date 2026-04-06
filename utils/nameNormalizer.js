function normalizePatientName(shortName) {
    const parts = shortName.split(' ');
    if (parts.length < 2) return null;

    const lastName = parts[0];
    const firstInitial = parts[1]?.charAt(0);
    const middleInitial = parts[1]?.charAt(2);

    if (!firstInitial) return null;

    return { lastName, firstInitial, middleInitial };
}

module.exports = { normalizePatientName };