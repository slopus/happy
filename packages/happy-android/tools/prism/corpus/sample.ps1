# Comment
param([string]$Name = "World", [int]$Count = 3)
function Get-Greeting {
    [CmdletBinding()]
    param($Who)
    return "Hello, $Who! $(Get-Date -Format 'yyyy')"
}
1..$Count | ForEach-Object { Write-Host (Get-Greeting -Who $Name) -ForegroundColor Green }
<# block
comment #>
