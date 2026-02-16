require('dotenv').config();

const { initDb } = require('./db');
const { startApp } = require('./app');
const { startBot } = require('./bot');
const { startScheduler } = require('./scheduler');

const db = initDb(process.env.DB_PATH);
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const bot = startBot(db);
startApp({ port, db, bot });
startScheduler({ db, bot });
