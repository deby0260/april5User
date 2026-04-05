# PowerShell script to remove comments from source files

# Function to remove comments from TypeScript/JavaScript files
function Remove-TSComments {
    param([string]$filePath)
    
    $content = Get-Content $filePath -Raw
    if ($content) {
        # Remove single-line comments (// comments)
        $content = $content -replace '//.*$', '' -split "`n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' -or $_ -match '\S' } | Join-String -Separator "`n"
        
        # Remove multi-line comments (/* */ comments)
        $content = $content -replace '/\*[\s\S]*?\*/', ''
        
        # Clean up extra whitespace
        $content = $content -replace '\n\s*\n', "`n"
        
        Set-Content $filePath $content -NoNewline
        Write-Host "Processed: $filePath"
    }
}

# Function to remove comments from SCSS/CSS files
function Remove-CSSComments {
    param([string]$filePath)
    
    $content = Get-Content $filePath -Raw
    if ($content) {
        # Remove single-line comments (// comments)
        $content = $content -replace '//.*$', '' -split "`n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' -or $_ -match '\S' } | Join-String -Separator "`n"
        
        # Remove multi-line comments (/* */ comments)
        $content = $content -replace '/\*[\s\S]*?\*/', ''
        
        # Clean up extra whitespace
        $content = $content -replace '\n\s*\n', "`n"
        
        Set-Content $filePath $content -NoNewline
        Write-Host "Processed: $filePath"
    }
}

# Function to remove comments from HTML files
function Remove-HTMLComments {
    param([string]$filePath)
    
    $content = Get-Content $filePath -Raw
    if ($content) {
        # Remove HTML comments (<!-- --> comments)
        $content = $content -replace '<!--[\s\S]*?-->', ''
        
        # Clean up extra whitespace
        $content = $content -replace '\n\s*\n', "`n"
        
        Set-Content $filePath $content -NoNewline
        Write-Host "Processed: $filePath"
    }
}

# Process TypeScript files
Write-Host "Removing comments from TypeScript files..."
Get-ChildItem -Path "src" -Recurse -Include "*.ts" | ForEach-Object {
    Remove-TSComments $_.FullName
}

# Process JavaScript files
Write-Host "Removing comments from JavaScript files..."
Get-ChildItem -Path "src" -Recurse -Include "*.js" | ForEach-Object {
    Remove-TSComments $_.FullName
}

# Process SCSS files
Write-Host "Removing comments from SCSS files..."
Get-ChildItem -Path "src" -Recurse -Include "*.scss" | ForEach-Object {
    Remove-CSSComments $_.FullName
}

# Process CSS files
Write-Host "Removing comments from CSS files..."
Get-ChildItem -Path "src" -Recurse -Include "*.css" | ForEach-Object {
    Remove-CSSComments $_.FullName
}

# Process HTML files
Write-Host "Removing comments from HTML files..."
Get-ChildItem -Path "src" -Recurse -Include "*.html" | ForEach-Object {
    Remove-HTMLComments $_.FullName
}

Write-Host "Comment removal completed!"
