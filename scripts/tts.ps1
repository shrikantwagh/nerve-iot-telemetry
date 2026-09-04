# Render narration lines to per-segment WAV files with the built-in Windows speech engine.
#
# One file per segment rather than one continuous take: the video is already cut, so each
# line has to start exactly on its own cut. Rendering separately lets ffmpeg place each
# line at an absolute timestamp, which keeps the voice locked to the picture even when a
# line comes in shorter than its budget.
#
# Only the legacy SAPI "Desktop" voices are installed here (David, Zira) -- no OneCore
# neural voices -- so intelligibility is bought with rate and punctuation, not with a
# better model. Rate is exposed per-run because the useful range is narrow: below -2 the
# voice drags audibly, above +1 it clips consonants.

param(
    [Parameter(Mandatory = $true)][string]$LinesJson,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$VoiceName = 'Microsoft David Desktop',
    [int]$Rate = 0
)

Add-Type -AssemblyName System.Speech

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$lines = Get-Content -Raw -Path $LinesJson -Encoding UTF8 | ConvertFrom-Json

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice($VoiceName)
} catch {
    Write-Output "voice '$VoiceName' unavailable; using default"
}
$synth.Rate = $Rate

foreach ($l in $lines) {
    $seg = [int]$l.segment
    # `speak` is the phonetic respelling, `text` is the script of record. They differ
    # where this engine mispronounces a proper noun -- "Xano" comes out wrong, so the
    # spoken form says "Zayno" while the written script stays readable for anyone
    # reviewing the copy. Fall back to `text` when no respelling is needed.
    $hasSpeak = ($l.PSObject.Properties.Name -contains 'speak')
    $text = if ($hasSpeak -and $l.speak) { [string]$l.speak } else { [string]$l.text }
    $path = Join-Path $OutDir ("seg{0:d2}.wav" -f $seg)

    $synth.SetOutputToWaveFile($path)
    $synth.Speak($text)
    # Release the file handle before measuring it, or the length reads as 0.
    $synth.SetOutputToNull()

    # Deliberately NOT reporting a duration here. Estimating it from the file size needs
    # the sample rate, and guessing that is how the first pass came out 38% wrong (SAPI
    # writes 22050 Hz, not the assumed 16 kHz). The caller measures with ffmpeg instead.
    $words = ($text -split '\s+' | Where-Object { $_ -ne '' }).Count
    $bytes = (Get-Item $path).Length
    Write-Output ("seg{0:d2}  {1,3} words  {2,8} bytes  {3}" -f $seg, $words, $bytes, [System.IO.Path]::GetFileName($path))
}

$synth.Dispose()
Write-Output "done: $OutDir"
