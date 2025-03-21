import {authenticate} from '@google-cloud/local-auth';
import fs from 'node:fs';
import {google} from 'googleapis';
import moment from 'moment';
import path from 'node:path';
import process from 'process';
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
    }
  }

  return records;
}

export async function archiveVideo({driveLocation, fileStream}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize();
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

export async function archiveTranscript({mediaType, docLocation, fileStream}) {
  // wait for OAuth2 authorization to Google Meet
  const auth = await authorize();
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

export async function generateSummary({config, meeting, date, transcript}) {
  let summary = `${meeting.name} transcript for ${date}`;
  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({model: 'gemini-1.5-flash'});
  const prompt = `
You are a useful meeting summary generator for W3C Community Group meetings.
You will be given a transcript in Markdown format of a meeting. The transcript
will contain the attendees and a full transcript of the discussion during
the meeting among the attendees. You will be expected to summarize the
meeting and provide the summary in Markdown format with a list of topics
covered during the meeting, and key points made in the meeting.
Only include topics covered and key points.
`;

  const result = await model.generateContent([
    {
      inlineData: {
        data: Buffer.from(transcript).toString('base64'),
        mimeType: 'text/md'
      },
    },
    prompt
  ]);
  summary = result.response.text();

  return summary;
}

export async function emailSummary(
  {config, meeting, email, date, transcript, summary}) {
  const converter = new showdown.Converter();

  // create email subject and body
  let to = email || meeting.email;
  let subject = `[MINUTES] ${meeting.name} ${date}`;
  const summaryHtml = converter.makeHtml(summary);
  const mdUrl =
    `${config.archiveUrl}${config.community}-${meeting.slug}-${date}.md`;
  const videoUrl =
    `${config.archiveUrl}${config.community}-${meeting.slug}-${date}.mp4`;
  const bodyMd = `
${summary}

Text: [${mdUrl}](${mdUrl})

Video: [${videoUrl}](${videoUrl})

${transcript}
`;
  const bodyHtml = converter.makeHtml(bodyMd);

  // wait for OAuth2 authorization to Google Mail
  const auth = await authorize();
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

export async function transcriptExists({transcriptFilename}) {
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