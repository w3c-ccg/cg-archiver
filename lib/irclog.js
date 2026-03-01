
/**
 * Convert seconds to HH:MM:SS format
 * @param {number} seconds - Seconds since midnight
 * @returns {string} Timestamp in HH:MM:SS format
 */
function secondsToTimestamp({seconds}) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse a Google Meet transcript into an array of entries
 * @param {string} transcript - The raw transcript text
 * @returns {Array} Array of {timestamp, speaker, text, keyword} objects
 */
function parseTranscript({transcript}) {
  const entries = [];
  const lines = transcript.toString().split('\n');
  const seenSpeakers = new Set();
  let currentSpeaker = null;
  let currentText = '';

  // First pass: collect all entries with their section timestamps
  const tempEntries = [];
  let sectionStartTimestamp = '00:00:00';

  for(let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Check if line is a timestamp (HH:MM:SS format)
    if(/^\d{2}:\d{2}:\d{2}$/.test(line)) {
      // Save previous entry if exists
      if(currentSpeaker && currentText) {
        tempEntries.push({
          sectionStartTimestamp,
          source: 'transcript',
          speaker: currentSpeaker,
          text: currentText.trim()
        });
      }
      sectionStartTimestamp = line;
      currentSpeaker = null;
      currentText = '';
      continue;
    }

    // Check if line starts with a speaker name (contains a colon)
    const speakerMatch = line.match(/^([^:]+):\s+(.*)$/);
    if(speakerMatch) {
      // Save previous entry if exists
      if(currentSpeaker && currentText) {
        tempEntries.push({
          sectionStartTimestamp,
          source: 'transcript',
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
    tempEntries.push({
      sectionStartTimestamp,
      source: 'transcript',
      speaker: currentSpeaker,
      text: currentText.trim()
    });
  }

  // Second pass: calculate evenly distributed timestamps for each section
  let currentSectionStart = '00:00:00';
  let sectionEntries = [];

  for(let i = 0; i < tempEntries.length; i++) {
    const entry = tempEntries[i];

    // If we've moved to a new section, process the previous section
    if(entry.sectionStartTimestamp !== currentSectionStart && sectionEntries.length > 0) {
      // Calculate time interval for the previous section
      const startSeconds = timestampToSeconds({timestamp: currentSectionStart});
      const endSeconds = timestampToSeconds({timestamp: entry.sectionStartTimestamp});
      const intervalSeconds = (endSeconds - startSeconds) / sectionEntries.length;

      // Assign evenly distributed timestamps
      for(let j = 0; j < sectionEntries.length; j++) {
        const estimatedSeconds = startSeconds + (j * intervalSeconds);
        const estimatedTimestamp = secondsToTimestamp({seconds: estimatedSeconds});

        // Add present+ entry for new speaker
        if(!seenSpeakers.has(sectionEntries[j].speaker)) {
          seenSpeakers.add(sectionEntries[j].speaker);
          entries.push({
            timestamp: estimatedTimestamp,
            source: 'transcript',
            speaker: sectionEntries[j].speaker,
            text: '',
            keyword: 'present+'
          });
        }

        entries.push({
          timestamp: estimatedTimestamp,
          source: 'transcript',
          speaker: sectionEntries[j].speaker,
          text: sectionEntries[j].text
        });
      }

      // Reset for new section
      sectionEntries = [];
      currentSectionStart = entry.sectionStartTimestamp;
    }

    sectionEntries.push(entry);
  }

  // Process the final section (use same timestamp for all entries)
  for(const entry of sectionEntries) {
    // Add present+ entry for new speaker
    if(!seenSpeakers.has(entry.speaker)) {
      seenSpeakers.add(entry.speaker);
      entries.push({
        timestamp: entry.sectionStartTimestamp,
        source: 'transcript',
        speaker: entry.speaker,
        text: '',
        keyword: 'present+'
      });
    }

    entries.push({
      timestamp: entry.sectionStartTimestamp,
      source: 'transcript',
      speaker: entry.speaker,
      text: entry.text
    });
  }

  return entries;
}

/**
 * Fetch HTML from URL and extract the title tag content
 * @param {string} url - The URL to fetch (must start with https://)
 * @returns {Promise<string|null>} The title content or null if not found/error
 */
async function fetchUrlTitle({url}) {
  if(!url.startsWith('https://')) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {'User-Agent': 'Mozilla/5.0 (compatible; cg-archiver/1.0)'},
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeoutId);

    if(!response.ok) {
      return null;
    }

    const html = await response.text();

    // Extract title tag content
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    return titleMatch && titleMatch[1] ? titleMatch[1].trim() : null;
  } catch(error) {
    return null;
  }
}

/**
 * Process text to enhance URLs with their page titles
 * @param {string} text - The text containing URLs
 * @returns {Promise<string>} The enhanced text with URL titles
 */
async function enhanceUrlsWithTitles({text}) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex);

  if(!urls) {
    return text;
  }

  let enhancedText = text;

  for(const url of urls) {
    const title = await fetchUrlTitle({url});
    if(title) {
      // Replace URL with URL -> 'Title' format
      enhancedText = enhancedText.replace(url, `${url} -> '${title}'`);
    }
  }

  return enhancedText;
}

/**
 * Parse a Google Meet chat log into an array of entries
 * @param {string} chatLog - The raw chat log text
 * @returns {Array} Array of {timestamp, speaker, text, keyword} objects
 */
async function parseChatLog({chatLog}) {
  const entries = [];
  const lines = chatLog.toString().split('\n');
  const seenSpeakers = new Set();

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
        const speakerMatch = contentLine.match(/^([^:]+):\s+(.*)$/);
        if(speakerMatch) {
          const speaker = speakerMatch[1].trim();
          let text = speakerMatch[2].trim();

          // Skip entries that start with /me or OFF: (case-insensitive)
          if(text.startsWith('/me') || /^off:/i.test(text)) {
            continue;
          }

          // Enhance URLs with their titles
          if(text.includes('https://')) {
            text = await enhanceUrlsWithTitles({text});
          }

          // Add present+ entry for new speaker
          if(!seenSpeakers.has(speaker)) {
            seenSpeakers.add(speaker);
            entries.push({
              timestamp,
              source: 'chat',
              speaker,
              text: '',
              keyword: 'present+'
            });
          }

          entries.push({
            timestamp,
            source: 'chat',
            speaker,
            text
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Convert timestamp string to seconds since the start of the transcript
 * @param {string} timestamp - Timestamp in HH:MM:SS format
 * @returns {number} Seconds since the start of the transcript
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
  const dateObj = new Date(`${date}T00:00:00-05:00`);
  const day = dateObj.toLocaleDateString('en-US', {day: 'numeric', timeZone: 'America/New_York'});
  const month = dateObj.toLocaleDateString('en-US', {month: 'long', timeZone: 'America/New_York'});
  const year = dateObj.toLocaleDateString('en-US', {year: 'numeric', timeZone: 'America/New_York'});

  // Add header
  ircLog += '00:00:00 <transcriber> scribe: transcriber\n';
  ircLog += `00:00:00 <transcriber> meeting: ${meeting.name}\n`;
  ircLog += `00:00:00 <transcriber> date: ${day} ${month} ${year}\n`;

  // Add each entry
  for(const entry of entries) {
    if(entry.keyword) {
      // Entry with keyword (e.g., present+)
      if(entry.keyword === 'present+') {
        ircLog += `${entry.timestamp} <transcriber> ${entry.keyword} ${entry.speaker.replaceAll(' ', '_')}\n`;
      }
    } else if(entry.source === 'chat') {
        ircLog += `${entry.timestamp} <${entry.speaker.replaceAll(' ', '_')}> ${entry.text} \n`;
    } else {
      // Regular entry with speaker and text
      ircLog += `${entry.timestamp} <transcriber> ${entry.speaker.replaceAll(' ', '_')}: ${entry.text}\n`;
    }
  }

  return ircLog;
}

/**
 * Parse AI-generated topics into an array of topic objects
 * @param {string} topics - AI-generated topics in format "HH:MM:SS TOPIC_TITLE"
 * @returns {Array} Array of {timestamp, title} objects
 */
function parseTopics({topics}) {
  const topicEntries = [];
  const lines = topics.toString().split('\n');

  for(const line of lines) {
    const trimmed = line.trim();
    if(trimmed === '') continue;

    // Match HH:MM:SS followed by topic title
    const match = trimmed.match(/^(\d{2}:\d{2}:\d{2})\s+(.+)$/);
    if(match) {
      topicEntries.push({
        timestamp: match[1],
        title: match[2].trim()
      });
    }
  }

  return topicEntries;
}

/**
 * Enhance IRC log by injecting AI-generated topics at appropriate timestamps
 * @param {string} topics - AI-generated topics in format "HH:MM:SS TOPIC_TITLE"
 * @param {string} ircLog - Original IRC log
 * @returns {Promise<string>} Enhanced IRC log with topics inserted
 */
export async function enhanceIrcLog({topics, ircLog}) {
  const topicEntries = parseTopics({topics});
  const ircLines = ircLog.split('\n');
  const enhancedLines = [];

  // Sort topics by timestamp
  topicEntries.sort((a, b) => {
    return timestampToSeconds({timestamp: a.timestamp}) - timestampToSeconds({timestamp: b.timestamp});
  });

  let topicIndex = 0;

  for(const ircLine of ircLines) {
    const trimmed = ircLine.trim();
    if(trimmed === '') {
      enhancedLines.push(ircLine);
      continue;
    }

    // Extract timestamp from IRC line
    const timestampMatch = ircLine.match(/^(\d{2}:\d{2}:\d{2})\s/);
    if(timestampMatch) {
      const lineTimestamp = timestampMatch[1];
      const lineSeconds = timestampToSeconds({timestamp: lineTimestamp});

      // Insert all topics that should appear before this line
      while(topicIndex < topicEntries.length) {
        const topicSeconds = timestampToSeconds({timestamp: topicEntries[topicIndex].timestamp});
        if(topicSeconds <= lineSeconds) {
          // Insert topic line
          enhancedLines.push(`${topicEntries[topicIndex].timestamp} <transcriber> topic: ${topicEntries[topicIndex].title}`);
          topicIndex++;
        } else {
          break;
        }
      }
    }

    enhancedLines.push(ircLine);
  }

  return enhancedLines.join('\n');
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
  const chatEntries = await parseChatLog({chatLog});

  // Merge and sort chronologically
  const mergedEntries = mergeEntries({transcriptEntries, chatEntries});

  // Format as IRC log
  const ircLog = formatAsIRC({entries: mergedEntries, meeting, date});

  return ircLog;
}
