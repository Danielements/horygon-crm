FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY Horygon.Core/ Horygon.Core/
COPY Horygon.Data/ Horygon.Data/
COPY Horygon.Email/ Horygon.Email/
COPY Horygon.AI/ Horygon.AI/
COPY Horygon.Server/ Horygon.Server/
COPY config/ config/
RUN dotnet publish Horygon.Server/Horygon.Server.csproj -c Release -o /out --self-contained false
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data && chown -R 1654:1654 /data
USER 1654:1654
ENV HORYGON_DATA=/data HORYGON_URLS=http://0.0.0.0:5080
EXPOSE 5080
ENTRYPOINT ["dotnet", "Horygon.Server.dll"]
