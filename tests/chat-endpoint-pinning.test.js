const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const config = require('../src/config/index.js');
const proxyHelper = require('../src/utils/proxy-helper.js');
const { HttpsProxyAgent } = require('https-proxy-agent');

const CHAT_HOST = 'chat.qwen.ai';
const GOOD_IP = '47.254.175.31';
const OTHER_IP = '47.91.78.155';

/**
 * Ставит списки входных адресов и сбрасывает всё, что закешировано.
 */
const setEndpoints = ({ chat = [], cli = [] } = {}) => {
  config.qwenChatEndpointIps = chat;
  config.qwenCliEndpointIps = cli;
  proxyHelper.reloadEndpointConfig();
};

test.afterEach(() => setEndpoints());

test('пустой список адресов — поведение прежнее', () => {
  setEndpoints();

  assert.equal(proxyHelper.getProxyAgent({ proxy: null }), undefined);
  assert.equal(proxyHelper.getActiveEndpointIp(proxyHelper.getChatBaseUrl()), null);
  assert.equal(proxyHelper.getEndpointIpCount(proxyHelper.getChatBaseUrl()), 0);

  const agent = proxyHelper.getProxyAgent({ proxy: 'http://127.0.0.1:9' });
  assert.ok(agent instanceof HttpsProxyAgent);
  assert.equal(agent.pin, undefined, 'без списка адресов агент не должен ничего закреплять');
});

test('без прокси: имя разрешается в закреплённый адрес, чужие имена не трогаются', async () => {
  setEndpoints({ chat: [GOOD_IP] });

  const agent = proxyHelper.getProxyAgent({ proxy: null });
  assert.ok(agent instanceof https.Agent);

  const lookup = agent.options.lookup;
  assert.equal(typeof lookup, 'function');

  // обычная форма вызова
  const plain = await new Promise((resolve, reject) => {
    lookup(CHAT_HOST, {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
  });
  assert.deepEqual(plain, { address: GOOD_IP, family: 4 });

  // форма с all: true (её использует Node при autoSelectFamily)
  const all = await new Promise((resolve, reject) => {
    lookup(CHAT_HOST, { all: true }, (err, result) => (err ? reject(err) : resolve(result)));
  });
  assert.deepEqual(all, [{ address: GOOD_IP, family: 4 }]);

  // чужое имя уходит в системное разрешение
  const other = await new Promise((resolve, reject) => {
    lookup('localhost', {}, (err, address) => (err ? reject(err) : resolve(address)));
  });
  assert.notEqual(other, GOOD_IP);
});

test('через прокси: CONNECT идёт на адрес, имя остаётся в приветствии и в проверке сертификата', async () => {
  setEndpoints({ chat: [GOOD_IP] });

  let connectLine = null;
  const opened = [];
  const proxy = net.createServer((socket) => {
    opened.push(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n\r\n')) return;
      connectLine = buffer.split('\r\n')[0];
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  // Подменяем tls.connect, чтобы поймать параметры приветствия: поднимать
  // настоящий TLS-сервер ради этого не нужно.
  // Агент дёргаем напрямую — вся машинерия http-клиента тут лишняя
  const originalTlsConnect = tls.connect;
  let tlsOptions = null;
  tls.connect = (options) => {
    tlsOptions = options;
    return new net.Socket();
  };

  try {
    const agent = proxyHelper.getProxyAgent({ proxy: `http://127.0.0.1:${proxyPort}` });
    const socket = await agent.connect(new EventEmitter(), {
      host: CHAT_HOST,
      port: 443,
      secureEndpoint: true
    });
    socket.destroy();
  } finally {
    tls.connect = originalTlsConnect;
    // Соединение с поддельным прокси остаётся открытым (настоящего TLS поверх
    // него не было) — без этого close() не дождётся закрытия
    for (const socket of opened) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }

  assert.equal(connectLine, `CONNECT ${GOOD_IP}:443 HTTP/1.1`, 'соединяться надо по адресу');
  assert.ok(tlsOptions, 'приветствие TLS не состоялось');
  assert.equal(tlsOptions.servername, CHAT_HOST, 'имя должно остаться в приветствии');
  assert.equal(tlsOptions.host, undefined, 'адрес не должен подменять имя при проверке сертификата');
  assert.notEqual(tlsOptions.rejectUnauthorized, false, 'проверку сертификата отключать нельзя');
});

test('агенты кешируются раздельно по адресу точки входа', () => {
  setEndpoints({ chat: [GOOD_IP, OTHER_IP] });
  const account = { proxy: 'http://127.0.0.1:9' };

  const first = proxyHelper.getProxyAgent(account);
  assert.equal(proxyHelper.getProxyAgent(account), first, 'один адрес — один агент');

  proxyHelper.rotateEndpointIp(proxyHelper.getChatBaseUrl(), GOOD_IP);
  const second = proxyHelper.getProxyAgent(account);

  assert.notEqual(second, first, 'после переключения адреса агент должен быть другим');
  assert.equal(second.pin.ip, OTHER_IP);
});

test('перебор адресов идёт по кругу и не крутится от повторных жалоб', () => {
  setEndpoints({ chat: [GOOD_IP, OTHER_IP] });
  const baseUrl = proxyHelper.getChatBaseUrl();

  assert.equal(proxyHelper.getActiveEndpointIp(baseUrl), GOOD_IP);
  assert.equal(proxyHelper.getEndpointIpCount(baseUrl), 2);

  assert.equal(proxyHelper.rotateEndpointIp(baseUrl, GOOD_IP), OTHER_IP);
  assert.equal(proxyHelper.getActiveEndpointIp(baseUrl), OTHER_IP);

  // Опоздавшая жалоба на уже смещённый адрес не должна крутить список дальше
  assert.equal(proxyHelper.rotateEndpointIp(baseUrl, GOOD_IP), OTHER_IP);
  assert.equal(proxyHelper.getActiveEndpointIp(baseUrl), OTHER_IP);

  assert.equal(proxyHelper.rotateEndpointIp(baseUrl, OTHER_IP), GOOD_IP);
});

test('один адрес в списке переключать некуда', () => {
  setEndpoints({ chat: [GOOD_IP] });
  assert.equal(proxyHelper.rotateEndpointIp(proxyHelper.getChatBaseUrl(), GOOD_IP), null);
  assert.equal(proxyHelper.getActiveEndpointIp(proxyHelper.getChatBaseUrl()), GOOD_IP);
});

test('закрепление chat не распространяется на узел CLI', () => {
  setEndpoints({ chat: [GOOD_IP] });
  const account = { proxy: 'http://127.0.0.1:9' };

  const cliAgent = proxyHelper.getProxyAgent(account, proxyHelper.getCliBaseUrl());
  assert.ok(cliAgent instanceof HttpsProxyAgent);
  assert.equal(cliAgent.pin, undefined, 'для portal.qwen.ai адрес chat закреплять нельзя');

  const chatAgent = proxyHelper.getProxyAgent(account);
  assert.equal(chatAgent.pin.ip, GOOD_IP);
  assert.notEqual(cliAgent, chatAgent);
});

test('у CLI свой список адресов', () => {
  setEndpoints({ cli: [OTHER_IP] });
  const account = { proxy: 'http://127.0.0.1:9' };

  assert.equal(proxyHelper.getProxyAgent(account, proxyHelper.getCliBaseUrl()).pin.ip, OTHER_IP);
  assert.equal(proxyHelper.getProxyAgent(account).pin, undefined);
});

test('смена прокси у аккаунта выбрасывает все его агенты', () => {
  setEndpoints({ chat: [GOOD_IP, OTHER_IP] });
  const proxyUrl = 'http://127.0.0.1:9';

  const first = proxyHelper.getProxyAgent({ proxy: proxyUrl });
  proxyHelper.invalidateProxyAgent(proxyUrl);
  const second = proxyHelper.getProxyAgent({ proxy: proxyUrl });

  assert.notEqual(second, first);
});
