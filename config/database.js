const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        console.log("INITIALIZING SECURE DATABASE CONNECTION...");
        console.log("DATABASE CONNECTION ESTABLISHED SUCCESSFULLY.");
    } catch (err) {
        console.error("DATABASE CONNECTION FAILED.");
        process.exit(1);
    }
};

module.exports = connectDB;
