import { Test, TestingModule } from '@nestjs/testing';
import { LanguagesService } from './languages.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Language } from './entities/language.entity';
import { Repository } from 'typeorm';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: jest.fn().mockImplementation(() => jest.fn()),
  getRepositoryToken: jest.fn().mockReturnValue('mock-token'),
  TypeOrmModule: { forFeature: jest.fn() },
}));

const mockRepository = {
  find: jest.fn(),
};

describe('LanguagesService', () => {
  let service: LanguagesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LanguagesService,
        {
          provide: getRepositoryToken(Language),
          useValue: mockRepository,
        },
        {
          provide: Repository,
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<LanguagesService>(LanguagesService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Should return an array of languages', async () => {
    // Arrange
    const fakeLanguages: Language[] = [
      { id: 1, name: 'Bnglish' },
      { id: 3, name: 'Aangla' },
      { id: 2, name: 'Erabic' },
    ];

    mockRepository.find.mockResolvedValue(fakeLanguages);

    // ACT
    const result = await service.findAll();

    // ASSERT
    expect(result).toEqual(fakeLanguages);
    expect(mockRepository.find).toHaveBeenCalledTimes(1);
  });

  it('should throw an error if repository fails', async () => {
    // Arrange
    const error = new Error('Database connection lost');
    mockRepository.find.mockRejectedValue(error);

    // Act & Assert
    await expect(service.findAll()).rejects.toThrow('Database connection lost');
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
