jest.mock('../../data-source', () => ({
  __esModule: true,
  default: { initialize: async () => ({}) },
}));

import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import * as express from 'express';
import * as request from 'supertest';
import { UserAccessControl } from 'src/auth/auth.guard';
import { MetadataService } from 'src/metadata/metadata.service';
import { SourceProvidersService } from 'src/source-providers/source-providers.service';
import {
  MediaSourcesController,
  ServiceOwnershipValidator,
} from './media-sources.controller';
import { MediaSourcesService } from './media-sources.service';
import { readStreamKey } from './stream-key';

const REPORTED_TITLE =
  'Менталист / The Mentalist (2008-2015) WEB-DL (S1-7E1-151 of 151) ТВ3';

const KEYS = [
  'ABCDEF0123456789',
  '0',
  '1',
  REPORTED_TITLE,
  'slash/name',
  '100% real',
  'a%20b',
  'what?',
  'hash#tag',
  'paren (2008)',
  'plus+plus',
  'q?x=1&y=2',
  'mix/%?#(字)',
];

const allow: CanActivate = {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    req.user = { id: 'user-1', isAdmin: true };
    return true;
  },
};

describe('v2.2.0 stream route', () => {
  it('returns the observed Cannot POST 404 when a title contains a slash', async () => {
    const app = express();
    app.post(
      '/api/sources/:sourceId/shows/tmdb/:tmdbId/season/:season/episode/:episode/streams/:key',
      (_req, res) => res.status(201).json({ ok: true }),
    );
    app.use((req, res) => {
      res.status(404).json({
        message: `Cannot ${req.method} ${req.originalUrl}`,
        error: 'Not Found',
        statusCode: 404,
      });
    });

    const legacy = `/api/sources/source-uuid/shows/tmdb/5920/season/1/episode/1/streams/${encodeURI(REPORTED_TITLE)}`;
    const response = await request(app).post(legacy).send({});

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      message: `Cannot POST ${legacy}`,
      error: 'Not Found',
      statusCode: 404,
    });
    expect(legacy).toContain(
      '/%D0%9C%D0%B5%D0%BD%D1%82%D0%B0%D0%BB%D0%B8%D1%81%D1%82%20/%20The%20Mentalist',
    );
  });
});

describe('stream key routes', () => {
  let app: INestApplication;
  const seen: { movie: string[]; episode: string[] } = {
    movie: [],
    episode: [],
  };

  beforeAll(async () => {
    const provider = {
      getMovieStreams: async () => ({
        candidates: [
          { key: 'ABCDEF0123456789', title: 'fixture', properties: [] },
        ],
      }),
      getEpisodeStreams: async () => ({
        candidates: [
          { key: 'ABCDEF0123456789', title: 'fixture', properties: [] },
        ],
      }),
      getMovieStream: async (
        _tmdb: string,
        _metadata: unknown,
        key: string,
      ) => {
        seen.movie.push(key);
        return { key, src: 'fixture://movie' };
      },
      getEpisodeStream: async (
        _tmdb: string,
        _metadata: unknown,
        key: string,
      ) => {
        seen.episode.push(key);
        return { key, src: 'fixture://episode' };
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [MediaSourcesController],
      providers: [
        {
          provide: MediaSourcesService,
          useValue: {
            findMediaSource: async () => ({
              id: 'source-uuid',
              pluginId: 'fixture',
              enabled: true,
              pluginSettings: {},
              userId: 'user-1',
            }),
          },
        },
        {
          provide: SourceProvidersService,
          useValue: {
            getProvider: () => provider,
          },
        },
        {
          provide: MetadataService,
          useValue: {
            getMovieByTmdbId: async () => ({
              tmdbMovie: { title: 'Fixture', release_date: '2008-01-01' },
            }),
            getSeriesByTmdbId: async () => ({
              tmdbSeries: {
                name: 'Fixture Series',
                seasons: [{ season_number: 1, episode_count: 12 }],
                last_episode_to_air: { runtime: 40 },
              },
            }),
          },
        },
      ],
    })
      .overrideGuard(UserAccessControl)
      .useValue(allow)
      .overrideGuard(ServiceOwnershipValidator)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(json());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reads a wildcard capture without decoding it again', () => {
    expect(readStreamKey({ '0': 'a%20b' })).toBe('a%20b');
    expect(readStreamKey({ key: 'already/decoded' })).toBe('already/decoded');
    expect(readStreamKey(undefined)).toBe('');
  });

  it.each(KEYS)('posts an encoded movie key unchanged: %s', async (key) => {
    const path = `/api/sources/source-uuid/movies/tmdb/550/streams/${encodeURIComponent(key)}`;
    const response = await request(app.getHttpServer()).post(path).send({});

    expect(response.status).toBe(201);
    expect(response.body.key).toBe(key);
    expect(seen.movie[seen.movie.length - 1]).toBe(key);
  });

  it.each(KEYS)('posts an encoded episode key unchanged: %s', async (key) => {
    const path = `/api/sources/source-uuid/shows/tmdb/5920/season/1/episode/1/streams/${encodeURIComponent(key)}`;
    const response = await request(app.getHttpServer()).post(path).send({});

    expect(response.status).toBe(201);
    expect(response.body.key).toBe(key);
    expect(response.body.src).toBe('fixture://episode');
    expect(seen.episode[seen.episode.length - 1]).toBe(key);
  });

  it('accepts the reported browser URL and passes the original title to the plugin', async () => {
    const legacy = `/api/sources/source-uuid/shows/tmdb/5920/season/1/episode/1/streams/${encodeURI(REPORTED_TITLE)}`;
    const response = await request(app.getHttpServer()).post(legacy).send({});

    expect(response.status).toBe(201);
    expect(response.body.key).toBe(REPORTED_TITLE);
    expect(seen.episode[seen.episode.length - 1]).toBe(REPORTED_TITLE);
  });

  it('still lists streams on the unchanged GET routes', async () => {
    const movies = await request(app.getHttpServer()).get(
      '/api/sources/source-uuid/movies/tmdb/550/streams',
    );
    const episodes = await request(app.getHttpServer()).get(
      '/api/sources/source-uuid/shows/tmdb/5920/season/1/episode/1/streams',
    );

    expect(movies.status).toBe(200);
    expect(episodes.status).toBe(200);
    expect(movies.body.candidates[0].key).toBe('ABCDEF0123456789');
    expect(episodes.body.candidates[0].key).toBe('ABCDEF0123456789');
  });
});
