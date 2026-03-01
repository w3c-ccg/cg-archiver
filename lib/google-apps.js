import {authenticate} from '@google-cloud/local-auth';
import {execSync} from 'node:child_process';
import fs from 'node:fs';
import {google} from 'googleapis';
import {mergeLogs, enhanceIrcLog} from './irclog.js';
import moment from 'moment';
import path from 'node:path';
import process from 'process';
import SftpClient from 'ssh2-sftp-client';
import showdown from 'showdown';
import {GoogleGenerativeAI} from '@google/generative-ai';

// If modifying these scopes, delete token.json.
const SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/gmail.send'
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
async function loadSavedCredentialsIfExist({config}) {
  try {
    let content = config.googleApiOauth2Token;
    if(content.length < 1) {
      content = fs.readFileSync(TOKEN_PATH);
    }
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
async function authorize({config}) {
  let client = await loadSavedCredentialsIfExist({config});
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

export async function getChatLogPath({meeting, startTime, endTime, config}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize({config});
  const driveClient = google.drive({version: 'v3', auth});
  const filter = `name CONTAINS "${meeting.name}" AND name CONTAINS "Chat" ` +
    `AND createdTime >= "${startTime}" AND createdTime <= "${endTime}"`;
  const docsLocation = {
    name: '',
    state: 'FILE_GENERATED',
    startTime,
    endTime,
    docsDestination: {
      document: '',
      exportUri: ''
    }
  };

  try {
    const result = await driveClient.files.list({
      q: filter,
      spaces: 'drive'
    });
    (result.data.files ?? []).forEach(file => {
      docsLocation.name = file.name;
      docsLocation.docsDestination = {
        document: file.id,
        exportUri:
          `https://drive.google.com/file/d/${file.id}/view?usp=drive_web`
      }
    });
  } catch(error) {
    console.error('  - FAILED to find Chat log');
    throw error;
  }

  return docsLocation;
}

export async function getRecords({meeting, date, config}) {
  // wait for OAuth2 authorization to Google Meet
  const records = {};
  const auth = await authorize({config});
  const meetClient = google.meet({version: 'v2', auth});
  const startTime = moment(date).toISOString();
  const endTime = moment(date).add(1, 'd').toISOString();
  const filter = `space.meeting_code = "${meeting.googleMeetId}" AND start_time>="${startTime}" AND end_time<="${endTime}"`;

  // get all the conferences records for the particular meeting and date
  let response = await meetClient.conferenceRecords.list({filter});

  // return if no conference records were found
  if(!response.data.conferenceRecords) {
    return records;
  }

  // process conference records
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

      // get the chatlog
      records.chatlog = await getChatLogPath({
        meeting, startTime, endTime, config});
    }
  }

  return records;
}

export async function downloadVideo({driveLocation, fileStream, config}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize({config});
  const driveClient = google.drive({version: 'v3', auth});

  try {
    const result = await driveClient.files.get({
      fileId: driveLocation.file,
      alt: 'media'
    }, {
      responseType: 'stream'
    }, (streamError, {data}) => {
      if(streamError) {
        console.error(streamError);
        return;
      }
      data
        .on('end', () => console.log('  - Video archival complete.'))
        .on('error', (fileError) => console.error(fileError))
        .pipe(fileStream);
    });
  } catch(error) {
    console.error('  - Video archival FAILED!');
    throw error;
  }
}

export async function downloadTranscript({mediaType, docLocation, fileStream, config}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize({config});
  const driveClient = google.drive({version: 'v3', auth});

  try {
    const result = await driveClient.files.export({
      fileId: docLocation.document,
      mimeType: mediaType
    }, {
      responseType: 'stream'
    }, (streamError, {data}) => {
      if(streamError) {
        console.error(streamError);
        return;
      }
      data
        .on('end', () => {
          console.log(`  - Transcript archival complete (${mediaType}).`);
        })
        .on('error', (fileError) => console.error(fileError))
        .pipe(fileStream);
    });
  } catch(error) {
    console.error('Failed to download transcript!');
    throw error;
  }
}

export async function downloadChatLog({mediaType, docLocation, fileStream, config}) {
  const auth = await authorize({config});
  const driveClient = google.drive({version: 'v3', auth});

  try {
    const result = await driveClient.files.get({
      fileId: docLocation.document,
      alt: 'media'
    }, {
      responseType: 'stream'
    }, (streamError, possibleData) => {
      if(streamError) {
        console.error(streamError);
        return;
      }
      if(possibleData === undefined) {
        fileStream.end('');
        return;
      }
      let {data} = possibleData;
      data
        .on('end', () => {
          console.log(`  - Chat log download complete (${mediaType}).`);
        })
        .on('error', (fileError) => console.error(fileError))
        .pipe(fileStream);
    });
  } catch(error) {
    console.error('Failed to download chat log!');
    throw error;
  }
}

export async function uploadToArchive({fileStream, filename, config}) {
  const sftp = new SftpClient('sftp-archive-client');
  const sftpConfig = {
    host: config.archive.host,
    username: config.archive.username,
    privateKey: config.archive.privateKey
  };
  const destinationFilename = path.join(config.archive.directory, filename);

  await sftp.connect(sftpConfig);
  await sftp.put(fileStream, destinationFilename);
  await sftp.end();
}

export async function generateSummary({config, meeting, date, transcript}) {
  let summary = `${meeting.name} transcript for ${date}`;
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({model: 'gemini-2.5-flash-lite'});
  const prompt = `
Generate a meeting summary for a technical standards meeting using the
provided transcript. The transcript contains the attendees and
the discussion they had during the meeting. Summarize the meeting in a paragraph
and then provide a bulleted list of topics that were covered during the meeting.
Use one sentence to summarize each major topic and up to two sentences to
summarize the outcome of the topic. List a set of action items that resulted
from the meeting at the end of the summary.
`;

  const result = await model.generateContent([
    {
      inlineData: {
        data: Buffer.from(transcript).toString('base64'),
        mimeType: 'text/plain'
      },
    },
    prompt
  ]);
  summary = result.response.text();

  return summary;
}

export async function generateIrcLog({config, meeting, date, transcript, chatLog}) {
  let summary = `${meeting.name} transcript for ${date}`;
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({model: 'gemini-2.5-flash-lite'});

  // generate the IRC log by combining the transcript and chat log
  let ircLog = await mergeLogs({config, meeting, date, transcript, chatLog});

  // enhance the IRC log with auto-generated topics
  let prompt = `
Read the provided IRC transcript and generate up to 6 topic titles that were
discussed. Your output should be in the following format:

HH:MM:SS TOPIC_TITLE

Where "HH:MM:SS" is the timestamp at which the topic started to be discussed
and TOPIC_TITLE is a title for the topic that is less than seven words in
length. Do not duplicate topics that are already specified via the "TOPIC:" or
"topic:" keywords. Use Title Case for the titles.
`;

  // generate the enhanced IRC log
  let result = await model.generateContent([
    {
      inlineData: {
        data: Buffer.from(ircLog).toString('base64'),
        mimeType: 'text/plain'
      },
    },
    prompt
  ]);
  const topics = result.response.text();
  const enhancedIrcLog = await enhanceIrcLog({topics, ircLog});

  return enhancedIrcLog;
}

export async function scribe2GenerateHtml({ircLogFilename}) {
  let htmlTranscript = '<html><body><p>Failed to generate HTML transcript.</p></body></html>';

  const command = `./scribe.perl --final ${ircLogFilename}`;
  htmlTranscript = await execSync(command).toString()
    .replace('Minutes manually created (not a transcript),',
      'This transcription was generated by a large language model (LLM) and ' +
      'might contain errors. When in doubt, check the audio recording.' +
      ' This page was ');

  return htmlTranscript;
}

export async function emailSummary(
  {meeting, email, date, transcript, summary, config}) {
  const converter = new showdown.Converter();

  // create email subject and body
  let to = email || meeting.email;
  let subject = `[MINUTES] ${meeting.name} ${date}`;
  const summaryHtml = converter.makeHtml(summary);
  const mdUrl =
    `${config.archive.url}${config.community}-${meeting.slug}-${date}.md`;
  const htmlUrl =
    `${config.archive.url}${config.community}-${meeting.slug}-${date}.html`;
  const videoUrl =
    `${config.archive.url}${config.community}-${meeting.slug}-${date}.mp4`;
  let bodyMd = `\n${summary}\n\nText: [${mdUrl}](${mdUrl})\n\n`;

  if(meeting.htmlTemplate) {
    bodyMd += `HTML: [${htmlUrl}](${htmlUrl})\n\n`;
  }
  bodyMd += `Video: [${videoUrl}](${videoUrl})\n\n${transcript}\n`;
  const bodyHtml = converter.makeHtml(bodyMd);

  // wait for OAuth2 authorization to Google Mail
  const auth = await authorize({config});
  const gmailClient = google.gmail({version: 'v1', auth});

  // format the email
  const headers = [
    `To: ${to}`,
    `Content-type: text/html;charset=iso-8859-1`,
    `MIME-Version: 1.0`,
    `Subject: ${subject}`,
    ``,
    ``
  ]
  let rawEmail = headers.join('\r\n');
  rawEmail += bodyHtml;

  // send the email
  const response = await gmailClient.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: Buffer.from(rawEmail).toString('base64')
    }
  });
}

export async function readTranscriptSync({transcriptFilename}) {
  let transcript = '';
  const startTime = Date.now();

  // see if we have a valid transcript every second for 15 seconds
  do {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      transcript = fs.readFileSync(transcriptFilename);
    } catch(error) {
      continue;
    }
  } while (!transcript.includes('### Meeting ended after') &&
    (Date.now() - startTime < 15000));

  return transcript;
}

export async function readChatLogSync({chatLogFilename}) {
  let chatlog = '';
  const startTime = Date.now();

  // see if we have a valid chatlog every second for 15 seconds
  do {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      chatlog = fs.readFileSync(chatLogFilename);
    } catch(error) {
      continue;
    }
  } while (!chatlog.includes('00:') &&
    (Date.now() - startTime < 15000));

  return chatlog;
}