const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// 1. IMPORTANDO O ARQUIVO DE PERSONAS
const personas = require('./personas.js');

// 2. ESCOLHA AQUI A PERSONA QUE QUER TESTAR ('barbearia', 'hamburgueria' ou 'clinica')
const personaAtual = personas.clinica;

const ai = new GoogleGenAI({ apiKey:'MINHA_CHAVE'});

const chatHistories = {};
const pausedChats = {};

const AGENDA_FILE = './agendamentos.json';

function carregarAgenda() {
    if (!fs.existsSync(AGENDA_FILE)) {
        fs.writeFileSync(AGENDA_FILE, JSON.stringify([]));
    }
    const data = fs.readFileSync(AGENDA_FILE, 'utf8');
    return JSON.parse(data);
}

function salvarAgendamento(novoAgendamento) {
    const agenda = carregarAgenda();
    agenda.push(novoAgendamento);
    fs.writeFileSync(AGENDA_FILE, JSON.stringify(agenda, null, 2));
}

function isChatPaused(chatId) {
    if (!pausedChats[chatId]) return false;
    const now = Date.now();
    if (now < pausedChats[chatId]) return true;
    delete pausedChats[chatId];
    return false;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log(`--- BOT PRONTO E RODANDO COM A PERSONA ATIVA! ---`);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (msg.message) {
                    const chatId = msg.key.remoteJid;
                    const messageType = Object.keys(msg.message)[0];

                    if (!chatHistories[chatId]) {
                        chatHistories[chatId] = [];
                    }

                    let userPromptText = "";

                    try {
                        if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                            userPromptText = msg.message.conversation || msg.message.extendedTextMessage?.text;
                            if (!userPromptText) continue;
                        } 
                        else if (messageType === 'imageMessage') {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const caption = msg.message.imageMessage?.caption || 'Analise esta imagem.';
                            
                            const imgAnalysis = await ai.models.generateContent({
                                model: 'gemini-3.6-flash',
                                contents: [
                                    { inlineData: { mimeType: 'image/jpeg', data: buffer.toString('base64') } },
                                    `Analise esta imagem: "${caption}"`
                                ]
                            });
                            userPromptText = `[Imagem enviada: ${imgAnalysis.text}]`;
                        } 
                        else if (messageType === 'audioMessage') {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            
                            const audioAnalysis = await ai.models.generateContent({
                                model: 'gemini-3.6-flash',
                                contents: [
                                    { inlineData: { mimeType: 'audio/ogg; codecs=opus', data: buffer.toString('base64') } },
                                    'Transcreva o áudio.'
                                ]
                            });
                            userPromptText = `[Áudio enviado: "${audioAnalysis.text}"]`;
                        } else {
                            continue;
                        }

                        if (userPromptText.trim().toLowerCase() === '!bot') {
                            delete pausedChats[chatId];
                            await sock.sendMessage(chatId, { text: '🤖 Atendimento automático da IA reativado!' }, { quoted: msg });
                            continue;
                        }

                        if (isChatPaused(chatId)) {
                            continue;
                        }

                        const agendaAtual = carregarAgenda();
                        const resumoAgenda = JSON.stringify(agendaAtual);

                        chatHistories[chatId].push({ role: 'user', parts: [{ text: userPromptText }] });

                        if (chatHistories[chatId].length > 10) {
                            chatHistories[chatId] = chatHistories[chatId].slice(-10);
                        }

                        // 3. JUNTAMOS A PERSONA COM A LISTA DE AGENDAMENTOS
                        const instrucaoCompleta = `${personaAtual}\n\nLISTA DE AGENDAMENTOS JÁ OCUPADOS NO SISTEMA:\n${resumoAgenda}`;

                        const response = await ai.models.generateContent({
                            model: 'gemini-3.6-flash',
                            contents: chatHistories[chatId],
                            config: {
                                systemInstruction: instrucaoCompleta
                            }
                        });

                        let replyText = response.text;

                        if (replyText.includes('[AGENDAR:')) {
                            const regex = /\[AGENDAR:\s*(.*?),\s*(.*?),\s*(.*?),\s*(.*?)\]/;
                            const match = replyText.match(regex);
                            
                            if (match) {
                                salvarAgendamento({
                                    chatId: chatId,
                                    nome: match[3].trim(),
                                    servico: match[4].trim(),
                                    data: match[1].trim(),
                                    hora: match[2].trim(),
                                    criadoEm: new Date().toISOString()
                                });
                            }
                            replyText = replyText.replace(/\[AGENDAR:.*?\]/g, '').trim();
                        }

                        if (replyText.includes('[PAUSAR_BOT]')) {
                            replyText = replyText.replace('[PAUSAR_BOT]', '').trim();
                            pausedChats[chatId] = Date.now() + (30 * 60 * 1000);
                        }

                        chatHistories[chatId].push({ role: 'model', parts: [{ text: replyText }] });
                        await sock.sendMessage(chatId, { text: replyText }, { quoted: msg });

                    } catch (error) {
                        console.error('Erro ao processar:', error.message || error);
                    }
                }
            }
        }
    });
}

connectToWhatsApp();
