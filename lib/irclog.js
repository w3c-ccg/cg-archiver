import fs from 'node:fs';
import moment from 'moment';
import path from 'node:path';
import process from 'process';

/**
 * Parse a Google Meet transcript into an array of entries
 * @param {string} transcript - The raw transcript text
 * @returns {Array} Array of {timestamp, speaker, text} objects
 */
function parseTranscript({transcript}) {
  const entries = [];
  const lines = transcript.toString().split('\n');
  let currentTimestamp = '00:00:00';
  let currentSpeaker = null;
  let currentText = '';

  for(let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if line is a timestamp (HH:MM:SS format)
    if(/^\d{2}:\d{2}:\d{2}$/.test(line)) {
      // Save previous entry if exists
      if(currentSpeaker && currentText) {
        entries.push({
          timestamp: currentTimestamp,
          speaker: currentSpeaker,
          text: currentText.trim()
        });
      }
      currentTimestamp = line;
      currentSpeaker = null;
      currentText = '';
      continue;
    }

    // Check if line starts with a speaker name (contains a colon)
    const speakerMatch = line.match(/^([^:]+):\s*(.*)$/);
    if(speakerMatch) {
      // Save previous entry if exists
      if(currentSpeaker && currentText) {
        entries.push({
          timestamp: currentTimestamp,
          speaker: currentSpeaker,
          text: currentText.trim()
        });
      }
      currentSpeaker = speakerMatch[1].trim();
      currentText = speakerMatch[2];
    } else if(currentSpeaker) {
      // Continuation of previous speaker's text
      currentText += ' ' + line;
    }
  }

  // Save final entry
  if(currentSpeaker && currentText) {
    entries.push({
      timestamp: currentTimestamp,
      speaker: currentSpeaker,
      text: currentText.trim()
    });
  }

  return entries;
}

/**
 * Parse a Google Meet chat log into an array of entries
 * @param {string} chatLog - The raw chat log text
 * @returns {Array} Array of {timestamp, speaker, text} objects
 */
function parseChatLog({chatLog}) {
  const entries = [];
  const lines = chatLog.toString().split('\n');

  for(let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if(line === '') continue;

    // Check if line is a timestamp (HH:MM:SS.mmm,HH:MM:SS.mmm format)
    const timestampMatch = line.match(/^(\d{2}:\d{2}:\d{2})\.\d{3},\d{2}:\d{2}:\d{2}\.\d{3}$/);
    if(timestampMatch) {
      const timestamp = timestampMatch[1];
      // Next line should be the speaker and text
      if(i + 1 < lines.length) {
        i++;
        const contentLine = lines[i].trim();
        const speakerMatch = contentLine.match(/^([^:]+):\s*(.*)$/);
        if(speakerMatch) {
          entries.push({
            timestamp,
            speaker: speakerMatch[1].trim(),
            text: speakerMatch[2].trim()
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Convert timestamp string to seconds since midnight
 * @param {string} timestamp - Timestamp in HH:MM:SS format
 * @returns {number} Seconds since midnight
 */
function timestampToSeconds({timestamp}) {
  const parts = timestamp.split(':');
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
}

/**
 * Merge and sort transcript and chat log entries chronologically
 * @param {Array} transcriptEntries - Parsed transcript entries
 * @param {Array} chatEntries - Parsed chat log entries
 * @returns {Array} Merged and sorted entries
 */
function mergeEntries({transcriptEntries, chatEntries}) {
  const allEntries = [...transcriptEntries, ...chatEntries];

  // Sort by timestamp (converted to seconds for numerical comparison)
  allEntries.sort((a, b) => {
    return timestampToSeconds({timestamp: a.timestamp}) - timestampToSeconds({timestamp: b.timestamp});
  });

  return allEntries;
}

/**
 * Format entries as IRC log
 * @param {Array} entries - Merged entries
 * @param {object} meeting - Meeting information
 * @param {string} date - Meeting date
 * @returns {string} Formatted IRC log
 */
function formatAsIRC({entries, meeting, date}) {
  let ircLog = '';

  // Add header
  ircLog += '00:00:00 <transcriber> scribe: transcriber\n';
  ircLog += `00:00:00 <transcriber> Meeting: ${meeting.name}\n`;
  ircLog += `00:00:00 <transcriber> Date: ${date}\n`;

  // Add each entry
  for(const entry of entries) {
    ircLog += `${entry.timestamp} <transcriber> ${entry.speaker}: ${entry.text}\n`;
  }

  return ircLog;
}

/**
 * Merge Google Meet transcript and chat log into IRC log format
 * @param {object} config - Configuration object
 * @param {object} meeting - Meeting information
 * @param {string} date - Meeting date
 * @param {string} transcript - Raw transcript text
 * @param {string} chatLog - Raw chat log text
 * @returns {Promise<string>} Formatted IRC log
 */
export async function mergeLogs({config, meeting, date, transcript, chatLog}) {
  // Parse both inputs
  const transcriptEntries = parseTranscript({transcript});
  const chatEntries = parseChatLog({chatLog});

  // Merge and sort chronologically
  const mergedEntries = mergeEntries({transcriptEntries, chatEntries});

  // Format as IRC log
  const ircLog = formatAsIRC({entries: mergedEntries, meeting, date});

  return ircLog;
}
