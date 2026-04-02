import { geminiApiKey } from './config.js';

export async function parseTimetableImage(base64Image) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiApiKey}`;

  console.log("Preparing Gemini Vision API request...");
  
  let mimeType = "image/jpeg";
  let base64Data = base64Image;
  
  // Extract mime type and raw base64 data
  if (base64Image.startsWith("data:")) {
    const parts = base64Image.split(',');
    mimeType = parts[0].split(':')[1].split(';')[0];
    base64Data = parts[1];
  }

  const requestBody = {
    contents: [{
      parts: [
        {
          text: `Analyze this college timetable image. Extract the schedule for Monday to Saturday, between 8:00 AM (08:00) and 6:00 PM (18:00) with hourly slots. 
          Return ONLY a valid JSON object matching exactly this structure:
          {
            "Monday": {
              "08:00": { "status": "busy", "subject": "Mathematics", "room": "A-101" },
              "09:00": { "status": "free" },
              // ...all hourly slots up to 18:00
            },
            "Tuesday": { ... }
            // ...up to Saturday
          }
          If a slot has a class, mark status as "busy" and provide "subject" and "room". If no class, mark status as "free". DO NOT wrap the output in markdown code blocks like \`\`\`json. Just return the raw JSON text.`
        },
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  try {
    console.log("Sending POST to Gemini...");
    
    // 30 second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    console.log("Received response from Gemini. Status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API Error:", errorText);
      throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const resultText = data.candidates[0].content.parts[0].text;
    
    // Parse the JSON string
    return JSON.parse(resultText);

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error("The request to Gemini timed out. Please try again with a clearer or smaller image.");
    }
    console.error("Error in parseTimetableImage:", error);
    throw error;
  }
}
