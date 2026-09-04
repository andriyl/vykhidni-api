import 'dotenv/config';
import {Client} from '@googlemaps/google-maps-services-js';


const googleClient = new Client({});

let logClients = [];

export function broadcastLog(message) {
  const payload = JSON.stringify({
    message,
    time: new Date().toISOString(),
  });

  logClients.forEach((client) => {
    try {
      client.socket.send(payload);
    } catch (err) {
      console.error("Failed to send log:", err);
    }
  });
}

export function addLogClient(connection) {
  if (!connection || !connection.socket) {
    console.error("⚠️ Tried to add invalid WebSocket connection");
    return;
  }

  const socket = connection.socket;
  logClients.push({ socket });

  socket.on("close", () => {
    logClients = logClients.filter((c) => c.socket !== socket);
  });
}

export function toUnix(dateStr, timeStr) {
  const separator = dateStr.match(/[^0-9]/)?.[0] || "/";
  const [day, month, year] = dateStr.split(separator).map(Number);

  const [hours, minutes] = timeStr.split(":").map(Number);

  const jsDate = new Date(year, month - 1, day, hours, minutes);
  return Math.floor(jsDate.getTime() / 1000);
}


export async function getCoordinates(address) {


  try {
    const response = await googleClient.geocode({
      params: {
        address: address, key: process.env.GOOGLE_MAPS_API_KEY, // Змінна оточення
        region: 'ua' // Обмежуємо регіон Україною
      }, timeout: 1000
    });

    const data = response.data;
    console.log('DATA', data);

    if (data.status === 'OK' && data.results.length > 0) {
      const {lat, lng} = data.results[0].geometry.location;
      return {lat: parseFloat(lat), lon: parseFloat(lng)};
    }
    return null;
  } catch (error) {
    console.error('Помилка:', error.message);
    return null;
  }
}





