const fs = require('fs');
function analizar() {
    if (fs.existsSync('./roadmap.json')) {
        const data = JSON.parse(fs.readFileSync('./roadmap.json', 'utf8'));
        console.log("LOG: Accediendo al Roadmap del CEO...");
        return data;
    }
}
analizar();