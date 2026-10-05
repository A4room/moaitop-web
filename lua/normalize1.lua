--[[
This file is part of "love.js" by 2dengine.
https://2dengine.com/doc/lovejs.html

MIT License

Copyright (c) 2022 2dengine LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
]]

-- normalize.lua is a series of hacks which ensure that
-- love.js behaves more closely to the downloadable version
love.js = {}
local cache = {}

local function encodeComponent(value)
  value = tostring(value or "")
  return (value:gsub("([^A-Za-z0-9_%.%-~])", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

local function bridgeUrl(target, action, ...)
  local url = "powpowbridge://" .. encodeComponent(target) .. "/" .. encodeComponent(action)
  local params = {}
  for i = 1, select("#", ...) do
    params[#params + 1] = "arg=" .. encodeComponent(select(i, ...))
  end
  if #params > 0 then
    url = url .. "?" .. table.concat(params, "&")
  end
  return url
end

function love.js.call(target, action, ...)
  -- todo: system module is required
  love.system = love.system or require('love.system')
  love.system.openURL(bridgeUrl(target, action, ...))

  -- read back the output stream
  for i = 1, 2^32 do
    local line = io.read()
    if not line then
      break
    end
    cache[i] = line
  end
  local output = table.concat(cache, '\n')

  -- clean up the cache
  for i = #cache, 1, -1 do
    cache[i] = nil
  end

  return output
end

local lfs = love.filesystem

--[[
-- hack that removes the leading slash from the identity string ("/love")
local _lfs_getIdentity = lfs.getIdentity
function lfs.getIdentity()
  local ident = _lfs_getIdentity()
  ident = ident:gsub("^/+", "")
  return ident
end
]]

local _lfs_getInfo = lfs.getInfo
local _lfs_read = lfs.read
function lfs.read(fn, ...)
  if not _lfs_getInfo(fn, 'file') then
    return nil, 'File does not exist: '..fn
  end
  return _lfs_read(fn, ...)
end

local _lfs_newFile = lfs.newFileData
function lfs.newFileData(fn, arg, ...)
  if not arg and not _lfs_getInfo(fn, 'file') then
    return nil, 'File does not exist: '..fn
  end
  return _lfs_newFile(fn, arg, ...)
end

local reg = debug.getregistry()
if reg then
  local _File_open = reg.File.open
  reg.File.open = function(file, ...)
    local fn = file:getFilename()
    if not _lfs_getInfo(fn) then
      return nil, 'File does not exist: '..fn
    end
    return _File_open(file, ...)
  end
end
