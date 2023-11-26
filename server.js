const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

let WebTorrentClient;
(async () => {
    const WebTorrent = (await import('webtorrent')).default;
    WebTorrentClient = new WebTorrent();
})();

const TMDB_API_KEY = '15791aad7489df31b7f80defdcfa07bd';

app.use(express.static('public'));

app.get('/api/search', async (req, res) => {
    try {
        const response = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(req.query.q)}&cat=200`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const activeDownloads = new Map();
const completedDownloads = new Set();
const torrentIdMap = new Map(); // Define torrentIdMap

app.get('/api/download', async (req, res) => {
    const infoHash = req.query.infoHash;

    if (activeDownloads.has(infoHash) || completedDownloads.has(infoHash)) {
        res.json({ message: 'Torrent is already being downloaded or has been downloaded' });
        return;
    }

    const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;

    try {
        const torrentId = generateTorrentId();
        activeDownloads.set(infoHash, torrentId);

        WebTorrentClient.add(magnetLink, { path: './downloads' }, torrent => {
            console.log(`Downloading: ${torrent.name}`);

            torrent.on('done', () => {
                organizeDownloadedContent(torrent);
                activeDownloads.delete(infoHash);
                completedDownloads.add(infoHash);
            });
        });

        res.json({ message: `Downloading torrent with infoHash: ${infoHash}`, torrentId: torrentId });
    } catch (error) {
        console.error('Error adding torrent:', error);
        res.status(500).send(`Error adding torrent: ${error.message}`);
        return;
    }
});

app.get('/api/download-stats', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendStats = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    WebTorrentClient.on('torrent', torrent => {
        const torrentId = generateTorrentId();
        torrentIdMap.set(torrent.infoHash, torrentId);

        torrent.on('download', () => {
            const stats = {
                torrentId: torrentIdMap.get(torrent.infoHash),
                name: torrent.name,
                progress: Math.round(torrent.progress * 100),
                downloadSpeed: torrent.downloadSpeed,
                uploaded: torrent.uploaded,
                peers: torrent.numPeers,
            };
            sendStats(stats);
        });
    });

    req.on('close', () => {
        console.log('Client disconnected from download stats');
    });
});

app.get('/api/movie', async (req, res) => {
    try {
        const torrentName = req.query.title;
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer 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'
            },
            body: JSON.stringify({
                "model": "gpt-3.5-turbo",
                "messages": [
                    {
                        "role": "system",
                        "content": "Extract the movie title from the following string and return exactly the movie title nothing more"
                    },
                    {
                        "role": "user",
                        "content": torrentName
                    }
                ],
                "temperature": 1,
                "max_tokens": 256,
                "top_p": 1,
                "frequency_penalty": 0,
                "presence_penalty": 0
            })
        });

        const openaiData = await openaiResponse.json();
        const title = openaiData.choices[0].message.content.trim();

        const tmdbResponse = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`);
        const movieData = await tmdbResponse.json();

        res.json(movieData);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Helper function to generate a unique torrent ID
function generateTorrentId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Function to organize downloaded content
function organizeDownloadedContent(torrent) {
    // Updated folder paths to include /Plex
    const moviesFolderPath = '/Plex/movies';
    const tvShowsFolderPath = '/Plex/tvshows';

    ensureDirectoryExists(moviesFolderPath);
    ensureDirectoryExists(tvShowsFolderPath);

    const videoFiles = torrent.files.filter(file => isVideoFile(file.name));

    if (videoFiles.length === 1) {
        moveFileToFolder(torrent.path, videoFiles[0], moviesFolderPath);
    } else if (videoFiles.length > 1) {
        moveTVShowContent(torrent, tvShowsFolderPath);
    }
}

function moveTVShowContent(torrent, tvShowsFolderPath) {
    const torrentFolderPath = path.join('./downloads', torrent.name);
    torrent.files.forEach(file => {
        if (isVideoFile(file.name)) {
            const fullPath = path.join(torrentFolderPath, file.path);
            const destinationPath = path.join(tvShowsFolderPath, torrent.name, file.path);
            ensureDirectoryExists(path.dirname(destinationPath));
            if (fs.existsSync(fullPath)) {
                fs.renameSync(fullPath, destinationPath);
                console.log(`Moved TV show file: ${file.path} to ${destinationPath}`);
            } else {
                console.log(`File not found: ${fullPath}`);
            }
        }
    });
}

function isVideoFile(fileName) {
    const fileExtension = path.extname(fileName).toLowerCase();
    const validExtensions = ['.mp4', '.avi', '.mkv'];
    return validExtensions.includes(fileExtension);
}

function moveFileToFolder(torrentPath, file, folderPath) {
    const sourcePath = path.join(torrentPath, file.path);
    const destPath = path.join(folderPath, file.name);
    if (fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, destPath);
        console.log(`Moved file: ${file.name} to ${folderPath}`);
    } else {
        console.log(`File not found: ${sourcePath}`);
    }
}

function ensureDirectoryExists(path) {
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path, { recursive: true });
    }
}
