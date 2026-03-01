import fs from 'node:fs';
import moment from 'moment';
import path from 'node:path';
import process from 'process';

export async function mergeLogs({config, meeting, date, transcript, chatLog}) {
  let ircLog = '';

  ircLog += `
00:00:00 <transcriber> scribe: transcriber
00:00:00 <transcriber> Meeting: ${meeting.name}
00:00:00 <transcriber> Date: ${date}
`

  return ircLog;
}
