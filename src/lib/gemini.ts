/**
 * Generate subtitles using the backend API.
 * This function handles the communication with the Express server.
 */
export async function generateSubtitles(
  mediaFile: File, 
  targetLanguage: string = "English", 
  detectGender: boolean = false,
  onProgress?: (chunk: string) => void
): Promise<string> {
  const formData = new FormData();
  // Ensure we provide a filename for Blobs to avoid issues with some browsers/servers
  const fileName = (mediaFile as any).name || "media_file.wav";
  formData.append("media", mediaFile, fileName);
  formData.append("targetLanguage", targetLanguage);
  formData.append("detectGender", String(detectGender));

  const response = await fetch("/api/subtitles/generate", {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
    },
    body: formData,
  });

  const contentType = response.headers.get("Content-Type");

  if (!response.ok) {
    // If the error response itself is HTML, check for cookie restrictions
    const errText = await response.text().catch(() => "");
    if (errText.includes("<title>Cookie check</title>") || errText.includes("Cookie check") || errText.includes("cookie-check")) {
      throw new Error("ការហៅទៅកាន់ API ត្រូវបានរារាំងដោយសារលក្ខខណ្ឌ Cookie របស់ Browser នៅក្នុង iframe (Third-party cookie restriction)។ សូមចុចប៊ូតុង 'Open in new tab' នៅផ្នែកខាងលើស្ដាំនៃ Live Preview ឬប្រើប្រាស់ Shared App URL ដើម្បីបន្តដំណើរការជាធម្មតា។ / API request was blocked due to browser third-party cookie restrictions in the preview iframe. Please click 'Open in new tab' or use the Shared App URL to process your request!");
    }
    
    // Otherwise try parsing as JSON
    let errorMsg = `Failed with status ${response.status}`;
    try {
      const errorData = JSON.parse(errText);
      errorMsg = errorData.error || errorMsg;
    } catch (e) {}
    throw new Error(errorMsg);
  }

  if (!contentType || (!contentType.includes("text/plain") && !contentType.includes("octet-stream"))) {
    const text = await response.text();
    console.error("Invalid response body start:", text.substring(0, 500));
    
    if (text.includes("<title>Cookie check</title>") || text.includes("Cookie check") || text.includes("cookie-check") || text.includes("<!doctype html>")) {
      throw new Error("ការហៅទៅកាន់ API ត្រូវបានរារាំងដោយសារលក្ខខណ្ឌ Cookie របស់ Browser នៅក្នុង iframe (Third-party cookie restriction)។ សូមចុចប៊ូតុង 'Open in new tab' នៅផ្នែកខាងលើស្ដាំនៃ Live Preview ឬប្រើប្រាស់ Shared App URL ដើម្បីបន្តដំណើរការជាធម្មតា។ / API request was blocked due to browser third-party cookie restrictions in the preview iframe. Please click 'Open in new tab' or use the Shared App URL to process your request!");
    }
    
    throw new Error(`ម៉ាស៊ីនបម្រើបានឆ្លើយតបជាទម្រង់មិនត្រឹមត្រូវ (Server returned an invalid response type: ${contentType})។ នេះអាចបណ្តាលមកពីកំហុសម៉ាស៊ីនបម្រើ ឬបញ្ហា Cookie។ សូមសាកល្បងបើកក្នុង Tab ថ្មី។`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response body is empty");
  }

  let fullContent = "";
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    fullContent += chunk;
    
    if (onProgress) {
      onProgress(chunk);
    }
  }

  return fullContent;
}
