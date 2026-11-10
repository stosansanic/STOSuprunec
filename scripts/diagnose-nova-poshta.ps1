$ErrorActionPreference = 'Stop'
# Read-only diagnostics. Never print or persist the API key or shipment values.
$secret = Read-Host 'API key from Nova Poshta business cabinet (hidden input)' -AsSecureString
$credential = [System.Net.NetworkCredential]::new('', $secret)
$apiKey = $credential.Password.Trim()
if (-not $apiKey) { throw 'API key is empty' }
$today = Get-Date
$from = $today.AddDays(-90)
$checks = @(
    @{ Name = 'created-documents'; Method = 'getDocumentList'; Properties = @{ DateTimeFrom = $from.ToString('dd.MM.yyyy'); DateTimeTo = $today.ToString('dd.MM.yyyy'); GetFullList = '0'; Page = '1' } },
    @{ Name = 'outgoing-api-key'; Method = 'getOutgoingDocumentsByPhone'; Properties = @{ DateFrom = $from.ToString('dd.MM.yyyy 00:00:00'); DateTo = $today.AddDays(1).ToString('dd.MM.yyyy 00:00:00'); Page = 1; Limit = 5; SearchByCounterparties = $null; iCounterparties = $null } },
    @{ Name = 'outgoing-web-system'; System = 'PA 3.0'; Method = 'getOutgoingDocumentsByPhone'; Properties = @{ DateFrom = $from.ToString('dd.MM.yyyy 00:00:00'); DateTo = $today.AddDays(1).ToString('dd.MM.yyyy 00:00:00'); Page = 1; Limit = 5; SearchByCounterparties = $null; iCounterparties = $null } },
    @{ Name = 'incoming-api-key'; Method = 'getIncomingDocumentsByPhone'; Properties = @{ DateFrom = $from.ToString('dd.MM.yyyy 00:00:00'); DateTo = $today.AddDays(1).ToString('dd.MM.yyyy 00:00:00'); Page = 1; Limit = 5 } }
)
try {
    foreach ($check in $checks) {
        $body = @{ apiKey = $apiKey; modelName = 'InternetDocument'; calledMethod = $check.Method; methodProperties = $check.Properties }
        if ($check.System) { $body.system = $check.System }
        $http = $null
        $stage = 'http'
        try {
            $http = Invoke-WebRequest -Uri 'https://api.novaposhta.ua/v2.0/json/' -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 30 -SkipHttpErrorCheck
            $stage = 'json'
            # Hashtable parsing handles JSON field names that differ only by case.
            $response = $http.Content | ConvertFrom-Json -AsHashtable
            if ($response -isnot [System.Collections.IDictionary]) { throw 'Unexpected JSON root' }
            $stage = 'summary'
            $rows = @($response.data | Where-Object { $null -ne $_ })
            # Some listing responses wrap documents in data[0].result.
            $wrapped = $rows.Count -eq 1 -and $rows[0] -is [System.Collections.IDictionary] -and $rows[0].Contains('result')
            if ($wrapped) { $rows = @($rows[0].result | Where-Object { $null -ne $_ }) }
            $fields = if ($rows.Count -and $rows[0] -is [System.Collections.IDictionary]) { @($rows[0].Keys) } else { @() }
            [ordered]@{
                check = $check.Name
                httpStatus = [int]$http.StatusCode
                success = $response.success -eq $true
                records = $rows.Count
                wrappedResult = $wrapped
                errorCodes = @($response.errorCodes | Where-Object { "$_" -match '^\d{1,20}$' })
                errors = @($response.errors | ForEach-Object { "$_" })
                translatedErrors = @($response.translatedErrors | ForEach-Object { "$_" })
                responseFields = @($response.Keys)
                firstRecordFields = $fields
                errorCount = @($response.errors | Where-Object { $null -ne $_ }).Count
                warningCount = @($response.warnings | Where-Object { $null -ne $_ }).Count
            } | ConvertTo-Json -Depth 4 -Compress
        } catch {
            # Do not print exception text: it may contain request headers or credentials.
            [ordered]@{
                check = $check.Name
                stage = $stage
                httpStatus = if ($http) { [int]$http.StatusCode } else { $null }
                contentType = if ($http) { "$($http.Headers['Content-Type'])" } else { $null }
                responseLength = if ($http) { $http.Content.Length } else { 0 }
                exceptionType = $_.Exception.GetType().Name
            } | ConvertTo-Json -Compress
        }
    }
} finally {
    $apiKey = $null
    $body = $null
    $credential = $null
    $secret.Dispose()
}
