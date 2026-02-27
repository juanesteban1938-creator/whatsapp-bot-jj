const client = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: '/tmp/.wwebjs_auth'  // cambiar de ./.wwebjs_auth
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});
