# Read-only light diagnostics. Compatible with Windows PowerShell 5.1 and PowerShell 7.
# No G-code is sent, and no printer configuration or application data is changed.
[CmdletBinding()]
param(
    [string]$PrinterHost = '192.168.1.102:7125',
    [string]$OutputPath = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:LightApiKey = $null
$script:LightApiKeyPrompted = $false
$script:LightRequests = New-Object 'System.Collections.Generic.List[object]'

function Get-Field {
    param($Value, [string]$Name)
    if ($null -eq $Value) { return $null }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Find-MoonrakerField {
    param($Value, [string]$Name)
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    if ($null -ne $Value) { $queue.Enqueue($Value) }
    $inspected = 0
    while ($queue.Count -gt 0 -and $inspected -lt 16) {
        $item = $queue.Dequeue()
        $inspected++
        $field = Get-Field $item $Name
        if ($null -ne $field) { return $field }
        foreach ($wrapper in @('result', 'data', 'response')) {
            $child = Get-Field $item $wrapper
            if ($null -ne $child -and $child -isnot [string]) { $queue.Enqueue($child) }
        }
    }
    return $null
}

function Get-HttpFailureStatus {
    param($Failure)
    try {
        $response = Get-Field $Failure.Exception 'Response'
        $status = Get-Field $response 'StatusCode'
        if ($null -ne $status) { return [int]$status }
    } catch { }
    return $null
}

function Request-ApiKey {
    $script:LightApiKeyPrompted = $true
    $secure = Read-Host 'Moonraker requires an API key (hidden input; Enter skips)' -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        if ($secure.Length -gt 0) {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ($plain.Length -gt 512 -or $plain -match '[\x00-\x20\x7f]') {
                throw 'Invalid API key format.'
            }
            $script:LightApiKey = $plain
            $plain = $null
        }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secure.Dispose()
    }
}

function Invoke-PrinterRead {
    param([string]$Label, [string]$Path)
    # Keep the network capability explicitly GET-only and on the chosen host.
    if ($Path -notmatch '^/(?:printer/(?:objects/(?:list|query)|gcode/help)|server/gcode_store)(?:\?|$)') {
        throw 'Unexpected diagnostic endpoint.'
    }
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $headers = @{}
        if ($null -ne $script:LightApiKey) { $headers['X-Api-Key'] = $script:LightApiKey }
        try {
            $response = Invoke-WebRequest -Uri ($script:LightBaseUri + $Path) -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop
            if ($response.Content.Length -gt 4194304) { throw 'Response exceeded the diagnostic size limit.' }
            $body = [string]$response.Content
            if ($response.Content -is [byte[]]) { $body = [Text.Encoding]::UTF8.GetString($response.Content) }
            if ($body -notmatch '^\s*\{') { throw 'Expected a JSON object response.' }
            $payload = $body | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne (Get-Field $payload 'error')) {
                [void]$script:LightRequests.Add([ordered]@{ request = $Label; ok = $false; httpStatus = [int]$response.StatusCode; error = 'Moonraker returned an error payload; raw error omitted.' })
                return $null
            }
            [void]$script:LightRequests.Add([ordered]@{ request = $Label; ok = $true; httpStatus = [int]$response.StatusCode })
            return $payload
        } catch {
            $status = Get-HttpFailureStatus $_
            if ($status -eq 401 -and -not $script:LightApiKeyPrompted) {
                Request-ApiKey
                if ($null -ne $script:LightApiKey) { continue }
            }
            $reason = 'Request failed, timed out, or returned invalid JSON; raw response omitted.'
            if ($status -eq 401 -or $status -eq 403) { $reason = 'Authorization required or denied.' }
            [void]$script:LightRequests.Add([ordered]@{ request = $Label; ok = $false; httpStatus = $status; error = $reason })
            return $null
        } finally {
            $headers.Clear()
        }
    }
    return $null
}

function Get-SafeNumber {
    param($Value)
    if ($null -eq $Value -or $Value -is [bool]) { return $null }
    $number = 0.0
    $valid = [double]::TryParse([string]$Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)
    if ($valid -and -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and [Math]::Abs($number) -le 1000000) { return $number }
    return $null
}

function Get-SafeLightSettings {
    param($Value)
    $result = [ordered]@{}
    $pin = Get-Field $Value 'pin'
    if ($pin -is [string] -and $pin -match '^[!\^~]*[A-Za-z0-9_:. -]{1,96}$') { $result['pin'] = $pin }
    $pwm = Get-Field $Value 'pwm'
    if ($pwm -is [bool]) { $result['pwm'] = $pwm }
    elseif ($pwm -is [string] -and $pwm -match '^(?i:true|false)$') { $result['pwm'] = [bool]::Parse($pwm) }
    foreach ($name in @('scale', 'value', 'static_value')) {
        $number = Get-SafeNumber (Get-Field $Value $name)
        if ($null -ne $number) { $result[$name] = $number }
    }
    return $result
}

function Protect-DiagnosticText {
    param([string]$Text, [int]$Limit = 320)
    # Do not serialize lines that may include credentials, even in an error.
    if ($Text -match '(?i)api[\s_-]*key|authorization|password|passwd|token|secret|credential') {
        return '[line omitted: possible access credentials]'
    }
    $safe = ($Text -replace '[\x00-\x1f\x7f]', ' ').Trim()
    if ($safe.Length -gt $Limit) { return $safe.Substring(0, $Limit) + '...' }
    return $safe
}

try {
    $authority = $PrinterHost.Trim()
    if ($authority -notmatch '^https?://') { $authority = 'http://' + $authority }
    $targetUri = $null
    if (-not [Uri]::TryCreate($authority, [UriKind]::Absolute, [ref]$targetUri) -or $targetUri.Scheme -notin @('http', 'https') -or $targetUri.UserInfo -or $targetUri.Query -or $targetUri.Fragment -or $targetUri.AbsolutePath -ne '/') {
        throw 'PrinterHost must contain only the printer hostname/IP and optional port.'
    }
    $script:LightBaseUri = $targetUri.GetLeftPart([UriPartial]::Authority)
    $lightName = '(?i)(?:light|led)'
    $lightSection = '^(?i:output_pin|pwm_cycle_time|led|neopixel|dotstar|gcode_macro) [A-Za-z0-9_]+$'
    $outputSection = '^(?i:output_pin|pwm_cycle_time|led|neopixel|dotstar) [A-Za-z0-9_]+$'

    $listed = Invoke-PrinterRead 'objects.list' '/printer/objects/list'
    $objects = @(Find-MoonrakerField $listed 'objects' | Where-Object { $_ -is [string] } | Select-Object -First 4096)
    $lightObjects = @($objects | Where-Object { $_ -match $lightSection -and $_ -match $lightName } | Sort-Object -Unique | Select-Object -First 32)

    $configuration = Invoke-PrinterRead 'light.configuration' '/printer/objects/query?configfile=settings,config'
    $status = Find-MoonrakerField $configuration 'status'
    $configfile = Get-Field $status 'configfile'
    if ($null -eq $configfile) { $configfile = Find-MoonrakerField $configuration 'configfile' }
    $sections = [ordered]@{}
    foreach ($source in @('config', 'settings')) {
        $settings = Get-Field $configfile $source
        if ($null -eq $settings) { continue }
        foreach ($property in $settings.PSObject.Properties) {
            $name = [string]$property.Name
            if ($name -notmatch $lightSection -or $name -notmatch $lightName -or $sections.Count -ge 32) { continue }
            if (-not $sections.Contains($name)) { $sections[$name] = [ordered]@{} }
            $sections[$name][$source] = Get-SafeLightSettings $property.Value
        }
    }
    # Query the standard K1 LED even when an incomplete catalogue omits it.
    # These are read queries only; no fallback command or actuator is invoked.
    $queryObjects = @(@('output_pin LED') + @($lightObjects) + @($sections.Keys) | Where-Object { $_ -match $outputSection } | Sort-Object -Unique | Select-Object -First 16)
    $live = New-Object 'System.Collections.Generic.List[object]'
    foreach ($objectName in $queryObjects) {
        $path = '/printer/objects/query?' + [Uri]::EscapeDataString($objectName)
        $response = Invoke-PrinterRead ('light.state: ' + $objectName) $path
        $liveStatus = Find-MoonrakerField $response 'status'
        if ($null -eq $liveStatus) { $liveStatus = $response }
        $row = Get-Field $liveStatus $objectName
        $entry = [ordered]@{ object = $objectName; reported = ($null -ne $row) }
        $rawValue = Get-Field $row 'value'
        $value = Get-SafeNumber $rawValue
        if ($rawValue -is [bool]) { $value = [int]$rawValue }
        if ($null -ne $value) { $entry['value'] = $value }
        $colors = Get-Field $row 'color_data'
        if ($null -ne $colors) {
            $safeColors = New-Object 'System.Collections.Generic.List[object]'
            foreach ($color in @($colors | Select-Object -First 4)) {
                $safeColor = @($color | Select-Object -First 4 | ForEach-Object { Get-SafeNumber $_ })
                if ($safeColor.Count -ge 3) { [void]$safeColors.Add($safeColor) }
            }
            if ($safeColors.Count -gt 0) { $entry['colorData'] = @($safeColors.ToArray()) }
        }
        [void]$live.Add($entry)
    }

    $helpResponse = Invoke-PrinterRead 'gcode.help' '/printer/gcode/help'
    $help = $helpResponse
    for ($depth = 0; $depth -lt 4; $depth++) {
        $nested = Get-Field $help 'result'
        if ($null -eq $nested) { break }
        $help = $nested
    }
    $commands = New-Object 'System.Collections.Generic.List[object]'
    if ($null -ne $help) {
        foreach ($property in $help.PSObject.Properties) {
            if ($property.Name -notmatch '^(?i:SET_PIN|SET_LED|[A-Za-z0-9_]*(?:LIGHT|LED)[A-Za-z0-9_]*)$' -or $commands.Count -ge 32) { continue }
            $entry = [ordered]@{ name = $property.Name }
            if ($property.Value -is [string]) { $entry['description'] = Protect-DiagnosticText $property.Value 160 }
            [void]$commands.Add($entry)
        }
    }

    $storeResponse = Invoke-PrinterRead 'gcode.store' '/server/gcode_store?count=100'
    $store = @(Find-MoonrakerField $storeResponse 'gcode_store')
    $messages = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in $store) {
        $message = Get-Field $item 'message'
        if ($message -isnot [string]) { continue }
        foreach ($line in @($message -split '\r?\n')) {
            if ($line -notmatch '(?i)LED|LIGHT|SET_PIN|Unknown|!!' -or $messages.Count -ge 100) { continue }
            $entry = [ordered]@{ message = Protect-DiagnosticText $line }
            # Epoch timestamps can exceed the actuator numeric limit.
            $rawTime = Get-Field $item 'time'
            if ($rawTime -is [double] -or $rawTime -is [long] -or $rawTime -is [int] -or $rawTime -is [decimal]) {
                if (-not [double]::IsNaN([double]$rawTime) -and -not [double]::IsInfinity([double]$rawTime)) { $entry['time'] = $rawTime }
            }
            $type = Get-Field $item 'type'
            if ($type -is [string] -and $type -match '^(command|response)$') { $entry['type'] = $type }
            [void]$messages.Add($entry)
        }
    }

    $report = [ordered]@{
        schemaVersion = 1
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        printer = $script:LightBaseUri
        readOnly = $true
        requests = @($script:LightRequests.ToArray())
        objects = [ordered]@{ totalCount = $objects.Count; lights = $lightObjects }
        lightConfiguration = $sections
        lightState = @($live.ToArray())
        lightCommands = @($commands.ToArray())
        recentLightMessages = @($messages.ToArray())
    }
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
        if ([string]::IsNullOrWhiteSpace($desktop)) { throw 'Desktop folder could not be found; provide -OutputPath.' }
        $OutputPath = Join-Path $desktop 'KF-K1-Light-Diagnostics.json'
    }
    $destination = [IO.Path]::GetFullPath($OutputPath)
    $directory = [IO.Path]::GetDirectoryName($destination)
    if (-not [IO.Directory]::Exists($directory)) { throw 'The output directory does not exist.' }
    $temporary = Join-Path $directory ('.KF-Light-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = $report | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
    Write-Host ('Saved read-only light diagnostics: ' + $destination)
    Write-Host 'No G-code was sent. Configuration and access credentials are not included.'
} finally {
    $script:LightApiKey = $null
}
