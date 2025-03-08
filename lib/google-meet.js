import {authenticate} from '@google-cloud/local-auth';
import fs from 'node:fs';
import {google} from 'googleapis';
import moment from 'moment';
import path from 'node:path';
import process from 'process';
import gmeet from '@google-apps/meet';
const {ConferenceRecordsServiceClient} = gmeet.v2;

// If modifying these scopes, delete token.json.
const SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/drive.meet.readonly'
];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// zeropad function
export function zeroPad(num, places) {
  return String(num).padStart(places, '0');
}

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
  try {
    const content = fs.readFileSync(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  fs.writeFileSync(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if(client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if(client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

export async function getRecords({meeting, date}) {
  // wait for OAuth2 authorization to Google Meet
  const records = {};
  const auth = await authorize();
  const meetClient = google.meet({version: 'v2', auth});
  const startTime = moment(date).toISOString();
  const endTime = moment(date).add(1, 'd').toISOString();
  const filter = `space.meeting_code = "${meeting}" AND start_time>="${startTime}" AND end_time<="${endTime}"`;

  // get all the conferences records for the particular meeting and date
  let response = await meetClient.conferenceRecords.list({filter});
  for(let record of response.data.conferenceRecords) {
    // see if there are any video recordings
    response = await meetClient.conferenceRecords.recordings.get(
      {name: record.name + '/recordings'});
    if(response.data.recordings) {
      records.recording = response.data.recordings[0];
      // check for video transcripts
      response = await meetClient.conferenceRecords.transcripts.list(
        {parent: record.name});
      if(response.data.transcripts) {
        records.transcript = response.data.transcripts[0];
      }
    }
  }

  return records;
}

export async function downloadVideo({driveLocation}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize();
  const driveClient = google.drive({version: 'v3', auth});
  let video;

  try {
    const result = await driveClient.files.get({
      fileId: driveLocation.file,
      alt: 'media'
    });
    video = result.data;
  } catch(error) {
    console.error('Failed to download video!');
    throw error;
  }

  return video;
}

export async function downloadTranscript({mediaType, docLocation}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize();
  const driveClient = google.drive({version: 'v3', auth});
  let transcript;

  try {
    const result = await driveClient.files.export({
      fileId: docLocation.document,
      mimeType: mediaType
    });
    transcript = result.data;
  } catch(error) {
    console.error('Failed to download transcript!');
    throw error;
  }

  return transcript;
}
